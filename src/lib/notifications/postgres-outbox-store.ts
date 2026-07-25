import { createHash } from "node:crypto";

import {
  PostProviderPersistenceUnknownError,
  ProviderBoundaryCommitUnknownError,
} from "./outbox-store-errors";
import type {
  BoundaryResult,
  GuardedDispatchResult,
  GuardedDispatchUncertainty,
  GuardedUnknownFinishResult,
  OutboxClaim,
  OutboxStore,
  PostFinishResult,
  PostProviderExit,
  PreFinishResult,
  PreProviderExit,
  ProviderCallPermit,
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
import {
  USER_AUTHORITY_ADVISORY_LOCK_SQL,
  USER_AUTHORITY_TRY_ADVISORY_LOCK_SQL,
  userAuthorityLockKey,
} from "@/lib/security/user-authority-lock";
import {
  PRODUCTION_EMAIL_TEMPLATES,
  requireDeletionCapabilityTemplateAuthority,
  requireSystemEmailTemplateAuthority,
  TEMPLATE_AUTHORITY_POLICIES,
  type DeletionCapabilityTemplateAuthority,
  type SystemEmailTemplateAuthority,
} from "./template-authority-policy";
import {
  accountDeletionNoticeBinding,
  deletionNoticeSecret,
  type AccountDeletionNoticeVariables,
} from "./deletion-notice-capability";
import type {
  DispatchBinding,
  MailDispatchAuthority,
  ProviderPayloadSha256,
} from "./prepared-dispatch";
import {
  buildRevocableSourceAuthorityQuery,
  parseRevocableSourceVariables,
  type RevocableSourceAuthorityQuery,
} from "./revocable-source-authority";
import {
  createStoreBoundPreparedDispatchChannel,
  preparedDispatchStoreView,
  sourceAuthoritySha256,
  type GuardedPreparedDispatch,
  type PreparedDispatchEnvelope,
  type PreparedDispatchRuntimePlan,
  type PreparedDispatchSource,
  type PreparedDispatchStoreInspection,
  type PreparedDispatchStoreView,
  type StoreBoundPreparedDispatchChannel,
} from "./prepared-dispatch-materialization";
import {
  isMailDispatchRuntimeStartupInspectionForPool,
  type MailDispatchRuntimeStartupInspection,
} from "./mail-dispatch-runtime-startup";
import {
  isMailDispatchHardWatchdogArmed,
  type ArmedMailDispatchHardWatchdog,
} from "./mail-dispatch-hard-watchdog";
import {
  connectMailDispatchDbWithin,
  createMailDispatchDbDeadline,
  queryMailDispatchDbWithin,
  type MailDispatchDbDeadline,
  type MailDispatchDbClientLease,
} from "./mail-dispatch-db-deadline";
import {
  terminateMailDispatchImmediately,
} from "./mail-dispatch-fatal-termination";
import {
  isFatalProviderTransportError,
  type CommittedPreparedDispatchReceipt,
} from "./provider-dispatch-contract";

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
  release(destroy?: boolean): void;
  once?(event: "end", listener: () => void): this;
  removeListener?(event: "end", listener: () => void): this;
}



export interface OutboxPgPool {
  connect(): Promise<OutboxPgClient>;
}

type StoreRuntimeState = {
  readonly startupInspection: MailDispatchRuntimeStartupInspection;
  readonly runtimePlan: PreparedDispatchRuntimePlan;
  binding?: object;
  channel?: StoreBoundPreparedDispatchChannel;
};

type CommittedReceiptState = Readonly<{
  store: PostgresOutboxStore;
  binding: object;
  envelope: PreparedDispatchEnvelope;
  permit: ProviderCallPermit;
  view: PreparedDispatchStoreView;
}>;

const STORE_RUNTIME_STATES = new WeakMap<
  PostgresOutboxStore,
  StoreRuntimeState
>();
const COMMITTED_RECEIPT_STATES = new WeakMap<
  CommittedPreparedDispatchReceipt,
  CommittedReceiptState
>();

export function bindPreparedDispatchChannel(
  store: PostgresOutboxStore,
  binding: object,
  runtimePlan: PreparedDispatchRuntimePlan,
): boolean {
  const state = STORE_RUNTIME_STATES.get(store);
  if (
    !state
    || state.binding !== undefined
    || state.channel !== undefined
    || state.runtimePlan !== runtimePlan
    || !Object.isFrozen(binding)
    || Reflect.ownKeys(binding).length !== 0
  ) return false;
  state.binding = binding;
  return true;
}

export function preparedDispatchChannelBindingMatches(
  store: PostgresOutboxStore,
  binding: object,
): boolean {
  const state = STORE_RUNTIME_STATES.get(store);
  return Boolean(
    state
    && state.binding === binding
    && state.channel?.binding === binding,
  );
}

export function consumeCommittedPreparedDispatchReceipt(
  binding: object,
  receipt: CommittedPreparedDispatchReceipt,
): Readonly<{
  envelope: PreparedDispatchEnvelope;
  permit: ProviderCallPermit;
  view: PreparedDispatchStoreView;
}> | null {
  const committed = COMMITTED_RECEIPT_STATES.get(receipt);
  if (
    !committed
    || !Object.isFrozen(receipt)
    || Reflect.ownKeys(receipt).length !== 0
    || committed.binding !== binding
    || !preparedDispatchChannelBindingMatches(committed.store, binding)
  ) return null;
  COMMITTED_RECEIPT_STATES.delete(receipt);
  return Object.freeze({
    envelope: committed.envelope,
    permit: committed.permit,
    view: committed.view,
  });
}

export function mailDispatchPreparedRuntimePlan(
  store: PostgresOutboxStore,
): PreparedDispatchRuntimePlan | null {
  return STORE_RUNTIME_STATES.get(store)?.runtimePlan ?? null;
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

type BindingRow = {
  dispatch_binding_version: string;
  dispatch_binding_sha256: string;
};

type ProviderAuthorityRow = BindingRow & {
  provider_correlation_version: string;
  provider_evidence_version: string | null;
  provider_evidence_sha256: string | null;
};

type BoundaryRow = ProviderAuthorityRow & {
  provider_call_started: string;
  lease_expires_at: string;
};

type TerminalRow = ProviderAuthorityRow & {
  status: string;
  claim_version: number;
  user_id: string | null;
  delivery_scope_key: string;
  adapter: string | null;
  provider_message_id: string | null;
  provider_call_started: Date | string | null;
  sent_at: Date | string | null;
  quarantined_at: Date | string | null;
  last_error_code: string | null;
  claim_token: string | null;
  claim_owner: string | null;
  lease_expires_at: Date | string | null;
};

type SweepCandidateRow = CandidateRow & {
  claim_token: string;
  claim_owner: string;
  lease_expires_at: string;
  adapter: string;
  provider_call_started: string;
  dispatch_binding_version: string | null;
  dispatch_binding_sha256: string | null;
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

type IssuedGmailReconciliationFenceState = Readonly<{
  store: PostgresOutboxStore;
}>;

const ISSUED_GMAIL_RECONCILIATION_FENCES = new WeakMap<
  GmailReconciliationFence,
  IssuedGmailReconciliationFenceState
>();

function issueGmailReconciliationFence(
  store: PostgresOutboxStore,
  fence: GmailReconciliationFence,
): GmailReconciliationFence {
  const issued = Object.freeze(fence);
  ISSUED_GMAIL_RECONCILIATION_FENCES.set(
    issued,
    Object.freeze({ store }),
  );
  return issued;
}

function consumeGmailReconciliationFence(
  store: PostgresOutboxStore,
  fence: GmailReconciliationFence,
) {
  const state = ISSUED_GMAIL_RECONCILIATION_FENCES.get(fence);
  if (state?.store !== store || !Object.isFrozen(fence)) return false;
  ISSUED_GMAIL_RECONCILIATION_FENCES.delete(fence);
  return true;
}const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;
const ADAPTERS = new Set(["console", "gmail"]);
const SHA256_HEX = /^[0-9a-f]{64}$/;

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
    throw new Error(
      "Outbox lease must be an integer from 15000 to 300000 milliseconds.",
    );
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
  const date =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime()))
    throw new Error(`${name} is not a valid timestamp.`);
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

function nonEmptySqlDisjunction(parts: readonly string[], authority: string) {
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
  PRODUCTION_EMAIL_TEMPLATES.flatMap((template) => {
    const policy = TEMPLATE_AUTHORITY_POLICIES[template];
    if (policy.scope !== "account") return [];
    const banned = nonEmptySqlDisjunction(
      policy.account.banned.map((value) => `account_user.banned = ${value}`),
      `Template authority ${template} banned states`,
    );
    const states = nonEmptySqlDisjunction(
      policy.account.states.map(
        (state) => `(
          account_user.role = ${trustedSqlLiteral(state.role)}
          and account_user.status = ${trustedSqlLiteral(state.status)}
          and account_user.email_verified = ${state.emailVerified}
        )`,
      ),
      `Template authority ${template} account states`,
    );
    return policy.versions.map(
      (version) => `(
        outbox.template = ${trustedSqlLiteral(template)}
        and outbox.template_version = ${trustedSqlLiteral(version)}
        and (${banned})
        and (${states})
      )`,
    );
  }),
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

type TransactionOptions<T> = Readonly<{
  commitUnknown?(result: T): Error;
  destroyOnWorkError?: boolean;
}>;

async function transaction<T>(
  pool: OutboxPgPool,
  work: (client: OutboxPgClient) => Promise<T>,
  options: TransactionOptions<T> = {},
) {
  const client = await pool.connect();
  let began = false;
  let commitAttempted = false;
  let destroy = false;
  try {
    await client.query("begin");
    began = true;
    const result = await work(client);
    commitAttempted = true;
    try {
      await client.query("commit");
    } catch {
      destroy = true;
      throw (
        options.commitUnknown?.(result) ??
        new Error("Outbox transaction commit result is unknown.")
      );
    }
    return result;
  } catch (error) {
    if (began && !commitAttempted) {
      try {
        await client.query("rollback");
      } catch {
        destroy = true;
      }
      if (options.destroyOnWorkError) {
        destroy = true;
      }
    } else if (!began) {
      destroy = true;
    }
    throw error;
  } finally {
    client.release(destroy);
  }
}

type GuardedDispatchUnknownState = Readonly<{
  store: PostgresOutboxStore;
  permit: ProviderCallPermit;
  exit: PostProviderExit;
}>;

const GUARDED_DISPATCH_UNKNOWN_STATES = new WeakMap<
  GuardedDispatchUncertainty,
  GuardedDispatchUnknownState
>();

function issueGuardedDispatchPersistenceUnknown(
  state: GuardedDispatchUnknownState,
): GuardedDispatchUncertainty {
  const uncertainty = Object.freeze({}) as GuardedDispatchUncertainty;
  GUARDED_DISPATCH_UNKNOWN_STATES.set(uncertainty, Object.freeze(state));
  return uncertainty;
}

function watchdogIsHealthy(
  watchdog: ArmedMailDispatchHardWatchdog,
): boolean {
  try {
    return isMailDispatchHardWatchdogArmed(watchdog);
  } catch {
    return false;
  }
}

function retainLiveTx2OrTerminate(
  watchdog: ArmedMailDispatchHardWatchdog,
): never {
  void watchdog;
  return terminateMailDispatchImmediately();
}

function discardGuardOrTerminate(
  channel: StoreBoundPreparedDispatchChannel,
  permit: ProviderCallPermit,
  guarded: GuardedPreparedDispatch,
  watchdog: ArmedMailDispatchHardWatchdog,
): void {
  try {
    if (channel.discardGuard(permit, guarded)) return;
  } catch {
    return retainLiveTx2OrTerminate(watchdog);
  }
  return retainLiveTx2OrTerminate(watchdog);
}

function deadlineBoundClient(
  lease: MailDispatchDbClientLease<OutboxPgClient>,
  deadline: MailDispatchDbDeadline,
): OutboxPgClient {
  return {
    query<Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: unknown[],
    ) {
      return queryMailDispatchDbWithin<Row, OutboxPgClient>({
        lease,
        deadline,
        text,
        ...(values === undefined ? {} : { values }),
      });
    },
    release() {
      throw new Error("Deadline-bound clients cannot release their owner lease.");
    },
  };
}

async function queryRetainingLiveTx2<
  Row extends Record<string, unknown> = Record<string, unknown>,
>(input: Readonly<{
  client: OutboxPgClient;
  deadline: MailDispatchDbDeadline;
  text: string;
  values?: unknown[];
  watchdog: ArmedMailDispatchHardWatchdog;
}>): Promise<QueryResult<Row>> {
  const remainingMs = input.deadline.remainingMs();
  if (remainingMs <= 0) return retainLiveTx2OrTerminate(input.watchdog);

  let query: Promise<QueryResult<Row>>;
  try {
    query = Promise.resolve(input.client.query<Row>(input.text, input.values));
  } catch (error) {
    throw error;
  }

  return new Promise<QueryResult<Row>>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      retainLiveTx2OrTerminate(input.watchdog);
    }, Math.max(0, Math.floor(remainingMs)));
    query.then(
      (result) => {
        if (settled) return;
        if (input.deadline.isExpired()) {
          settled = true;
          clearTimeout(timer);
          retainLiveTx2OrTerminate(input.watchdog);
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        if (settled) return;
        if (input.deadline.isExpired()) {
          settled = true;
          clearTimeout(timer);
          retainLiveTx2OrTerminate(input.watchdog);
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

type ObservedProviderSettlement =
  | Readonly<{ kind: "fulfilled"; exit: PostProviderExit }>
  | Readonly<{ kind: "rejected"; error: unknown }>;

function observeLiveProviderWithin(
  operation: Promise<PostProviderExit>,
  deadlineMs: number,
  watchdog: ArmedMailDispatchHardWatchdog,
): Promise<ObservedProviderSettlement> {
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observed = operation.then(
      (exit) => Object.freeze({ kind: "fulfilled" as const, exit }),
      (error: unknown) => {
        if (isFatalProviderTransportError(error)) {
          return retainLiveTx2OrTerminate(watchdog);
        }
        return Object.freeze({ kind: "rejected" as const, error });
      },
    );
    const deadline = new Promise<never>(() => {
      timer = setTimeout(
        () => retainLiveTx2OrTerminate(watchdog),
        deadlineMs,
      );
    });
    return Promise.race([observed, deadline]).then(
      (settlement) => {
        try {
          if (timer !== undefined) clearTimeout(timer);
          if (!watchdogIsHealthy(watchdog)) {
            return retainLiveTx2OrTerminate(watchdog);
          }
          return settlement;
        } catch {
          return retainLiveTx2OrTerminate(watchdog);
        }
      },
      () => retainLiveTx2OrTerminate(watchdog),
    );
  } catch {
    return retainLiveTx2OrTerminate(watchdog);
  }
}

type SettledProviderClientState = {
  readonly pool: OutboxPgPool;
  readonly client: OutboxPgClient;
  readonly transactionId: string;
  readonly scopeLockKey: string;
  readonly teardownConfirmationMs: number;
  closed: boolean;
  teardownConfirmed: boolean;
};

function waitForSettledProviderClientEndOrTerminate(
  state: SettledProviderClientState,
  deadline: MailDispatchDbDeadline,
  watchdog: ArmedMailDispatchHardWatchdog,
): Promise<void> {
  if (state.closed) return Promise.resolve();
  const once = state.client.once;
  const removeListener = state.client.removeListener;
  const remainingMs = deadline.remainingMs();
  if (
    typeof once !== "function"
    || typeof removeListener !== "function"
    || remainingMs <= 0
  ) return retainLiveTx2OrTerminate(watchdog);

  return new Promise<void>((resolve) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onEnd = () => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      try {
        removeListener.call(state.client, "end", onEnd);
      } catch {
        return retainLiveTx2OrTerminate(watchdog);
      }
      state.closed = true;
      resolve();
    };

    try {
      once.call(state.client, "end", onEnd);
      timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        try {
          removeListener.call(state.client, "end", onEnd);
        } catch {
          return retainLiveTx2OrTerminate(watchdog);
        }
        return retainLiveTx2OrTerminate(watchdog);
      }, Math.max(0, Math.floor(remainingMs)));
      state.client.release(true);
    } catch {
      if (timer !== undefined) clearTimeout(timer);
      try {
        removeListener.call(state.client, "end", onEnd);
      } catch {
        return retainLiveTx2OrTerminate(watchdog);
      }
      return retainLiveTx2OrTerminate(watchdog);
    }
  });
}

async function confirmSettledTransactionAndLockReleaseOrTerminate(
  state: SettledProviderClientState,
  deadline: MailDispatchDbDeadline,
  watchdog: ArmedMailDispatchHardWatchdog,
): Promise<void> {
  if (state.teardownConfirmed) return;
  let proofLease: MailDispatchDbClientLease<OutboxPgClient>;
  try {
    proofLease = await connectMailDispatchDbWithin({
      pool: state.pool,
      deadline,
    });
  } catch {
    return retainLiveTx2OrTerminate(watchdog);
  }

  try {
    let terminal = false;
    while (!deadline.isExpired()) {
      const proof = await queryMailDispatchDbWithin<{
        transaction_status: string | null;
      }, OutboxPgClient>({
        lease: proofLease,
        deadline,
        text:
          "select pg_catalog.pg_xact_status($1::xid8)::text "
          + "as transaction_status",
        values: [state.transactionId],
      });
      const row = proof.rows.length === 1 ? proof.rows[0] : undefined;
      if (!row || (
        row.transaction_status !== "in progress"
        && row.transaction_status !== "committed"
        && row.transaction_status !== "aborted"
      )) {
        if (!proofLease.isReleased) proofLease.destroy();
        return retainLiveTx2OrTerminate(watchdog);
      }
      if (
        row.transaction_status === "committed"
        || row.transaction_status === "aborted"
      ) {
        terminal = true;
        break;
      }
      const remainingMs = deadline.remainingMs();
      if (remainingMs <= 0) break;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(10, Math.max(1, Math.floor(remainingMs))));
      });
    }
    if (!terminal) {
      if (!proofLease.isReleased) proofLease.destroy();
      return retainLiveTx2OrTerminate(watchdog);
    }

    const remainingMs = deadline.remainingMs();
    if (remainingMs <= 1) {
      if (!proofLease.isReleased) proofLease.destroy();
      return retainLiveTx2OrTerminate(watchdog);
    }
    const barrierLockMs = Math.max(1, Math.floor(remainingMs / 2));
    await queryMailDispatchDbWithin({
      lease: proofLease,
      deadline,
      text: "begin",
    });
    await queryMailDispatchDbWithin({
      lease: proofLease,
      deadline,
      text: `set local lock_timeout = '${barrierLockMs}ms'`,
    });
    await queryMailDispatchDbWithin({
      lease: proofLease,
      deadline,
      text: USER_AUTHORITY_ADVISORY_LOCK_SQL,
      values: [state.scopeLockKey],
    });
    await queryMailDispatchDbWithin({
      lease: proofLease,
      deadline,
      text: "commit",
    });
    try {
      proofLease.release();
    } catch {
      return retainLiveTx2OrTerminate(watchdog);
    }
    state.teardownConfirmed = true;
    return;
  } catch {
    if (!proofLease.isReleased) {
      try {
        proofLease.destroy();
      } catch {
        // The canonical terminator below remains authoritative.
      }
    }
    return retainLiveTx2OrTerminate(watchdog);
  }

  if (!proofLease.isReleased) {
    try {
      proofLease.destroy();
    } catch {
      // The canonical terminator below remains authoritative.
    }
  }
  return retainLiveTx2OrTerminate(watchdog);
}

async function destroySettledProviderClientOrTerminate(
  state: SettledProviderClientState,
  watchdog: ArmedMailDispatchHardWatchdog,
): Promise<void> {
  if (state.teardownConfirmed) return;
  const deadline = createMailDispatchDbDeadline({
    phase: "post-provider",
    budgetMs: state.teardownConfirmationMs,
  });
  await waitForSettledProviderClientEndOrTerminate(state, deadline, watchdog);
  await confirmSettledTransactionAndLockReleaseOrTerminate(
    state,
    deadline,
    watchdog,
  );
}

async function queryAfterProviderWithin<
  Row extends Record<string, unknown> = Record<string, unknown>,
>(input: Readonly<{
  state: SettledProviderClientState;
  deadline: MailDispatchDbDeadline;
  text: string;
  values?: unknown[];
  watchdog: ArmedMailDispatchHardWatchdog;
}>): Promise<QueryResult<Row>> {
  if (input.state.closed) {
    throw new Error("Mail dispatch database client is already closed.");
  }

  const failDeadline = async (): Promise<never> => {
    await destroySettledProviderClientOrTerminate(input.state, input.watchdog);
    throw new Error("Post-provider database deadline exceeded.");
  };
  const remainingMs = input.deadline.remainingMs();
  if (remainingMs <= 0) return failDeadline();

  let query: Promise<QueryResult<Row>>;
  try {
    query = Promise.resolve(
      input.state.client.query<Row>(input.text, input.values),
    );
  } catch (error) {
    if (input.deadline.isExpired()) return failDeadline();
    throw error;
  }

  return new Promise<QueryResult<Row>>((resolve, reject) => {
    let settled = false;
    const expire = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void failDeadline().catch((error: unknown) => reject(error));
    };
    const timer = setTimeout(expire, Math.max(0, Math.floor(remainingMs)));
    query.then(
      (result) => {
        if (settled) return;
        if (input.deadline.isExpired()) {
          expire();
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        if (settled) return;
        if (input.deadline.isExpired()) {
          expire();
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function releaseBeforePhysicalInitiation(
  lease: MailDispatchDbClientLease<OutboxPgClient>,
  deadline: MailDispatchDbDeadline,
  began: boolean,
  watchdog: ArmedMailDispatchHardWatchdog,
): Promise<void> {
  if (lease.isReleased || !began || deadline.isExpired()) {
    return retainLiveTx2OrTerminate(watchdog);
  }
  try {
    await queryMailDispatchDbWithin({
      lease,
      deadline,
      text: "rollback",
    });
  } catch {
    return retainLiveTx2OrTerminate(watchdog);
  }
  try {
    lease.release();
  } catch {
    return retainLiveTx2OrTerminate(watchdog);
  }
}

async function advisoryLock(
  client: OutboxPgClient,
  key: string,
  wait: boolean,
) {
  if (wait) {
    await client.query(
      USER_AUTHORITY_ADVISORY_LOCK_SQL,
      [key],
    );
    return true;
  }
  const result = await client.query<{ locked: boolean }>(
    USER_AUTHORITY_TRY_ADVISORY_LOCK_SQL,
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
  userId: string | null;
  deliveryScopeKey: string;
}>;

type BoundaryDecision =
  | "allowed"
  | "ACCOUNT_NOT_ACTIVE_AT_PROVIDER_BOUNDARY"
  | "SYSTEM_EMAIL_AUTHORITY_INVALID"
  | "DELETION_NOTICE_CAPABILITY_INVALID"
  | "MAIL_SOURCE_AUTHORITY_INVALID"
  | "BACKUP_AUTHORITY_UNAVAILABLE";

async function lockFenceScope(
  client: OutboxPgClient,
  fence: ClaimFenceInput,
  wait: boolean,
): Promise<DeliveryScope | null> {
  const expectedScope = deliveryScope({
    operation_id: fence.operationId,
    user_id: fence.userId,
    delivery_scope_key: fence.deliveryScopeKey,
  });
  if (!(await advisoryLock(client, expectedScope.lockKey, wait))) return null;
  const result = await client.query<CandidateRow>(
    `
    select id::text, user_id, operation_id::text, delivery_scope_key, claim_version
    from public.email_outbox
    where id = $1::uuid
      and operation_id = $2::uuid
      and claim_token = $3::uuid
      and claim_owner = $4::text
      and claim_version = $5::integer
      and user_id is not distinct from $6::text
      and delivery_scope_key = $7::text
    for update
  `,
    [
      fence.id,
      fence.operationId,
      fence.claimToken,
      fence.claimOwner,
      fence.claimVersion,
      expectedScope.userId,
      expectedScope.key,
    ],
  );
  if (result.rows.length !== 1) return null;
  const row = result.rows[0]!;
  const scope = deliveryScope(row);
  return scope.key === expectedScope.key &&
    scope.userId === expectedScope.userId
    ? scope
    : null;
}

type PermitFenceInput = ClaimFenceInput &
  Readonly<{
    adapter: string;
    providerCallStartedAt: string;
    leaseExpiresAt: string;
    bindingVersion: DispatchBinding["bindingVersion"];
    bindingSha256: ProviderPayloadSha256;
    sourceAuthoritySha256:
      PreparedDispatchStoreInspection["sourceAuthoritySha256"];
    authorityEvidence?:
      PreparedDispatchStoreInspection["authorityEvidence"];
    providerCorrelationVersion:
      PreparedDispatchStoreInspection["providerCorrelationVersion"];
    providerEvidenceVersion:
      PreparedDispatchStoreInspection["providerEvidenceVersion"];
    providerEvidenceSha256:
      PreparedDispatchStoreInspection["providerEvidenceSha256"];
  }>;

type PermitState = PermitFenceInput & Readonly<{
  store: PostgresOutboxStore;
  envelope: PreparedDispatchEnvelope;
  view: PreparedDispatchStoreView;
}>;

const PERMIT_STATES = new WeakMap<ProviderCallPermit, PermitState>();
const DISPATCHED_PERMITS = new WeakSet<ProviderCallPermit>();
const CLAIMED_HARD_WATCHDOGS = new WeakMap<
  ArmedMailDispatchHardWatchdog,
  PostgresOutboxStore
>();
const SAFE_GUARDED_DISPATCH_RESULTS = new WeakMap<
  GuardedDispatchResult,
  Readonly<{
    store: PostgresOutboxStore;
    watchdog: ArmedMailDispatchHardWatchdog;
  }>
>();

function issueSafeGuardedDispatchResult<T extends GuardedDispatchResult>(
  store: PostgresOutboxStore,
  watchdog: ArmedMailDispatchHardWatchdog,
  result: T,
): T {
  const issued = Object.freeze(result) as T;
  SAFE_GUARDED_DISPATCH_RESULTS.set(issued, Object.freeze({
    store,
    watchdog,
  }));
  return issued;
}

export function releaseGuardedDispatchWatchdogClaim(
  store: object,
  watchdog: ArmedMailDispatchHardWatchdog,
): boolean {
  try {
    if (
      CLAIMED_HARD_WATCHDOGS.get(watchdog) !== store
      || watchdogIsHealthy(watchdog)
    ) return false;
    CLAIMED_HARD_WATCHDOGS.delete(watchdog);
    return true;
  } catch {
    return false;
  }
}

export function guardedDispatchResultSafeToDisarm(
  store: object,
  watchdog: ArmedMailDispatchHardWatchdog,
  result: GuardedDispatchResult,
): boolean {
  try {
    if (!result || typeof result !== "object") return false;
    const issued = SAFE_GUARDED_DISPATCH_RESULTS.get(result);
    if (
      !issued
      || issued.store !== store
      || issued.watchdog !== watchdog
      || CLAIMED_HARD_WATCHDOGS.get(watchdog) !== store
      || !Object.isFrozen(result)
    ) return false;
    SAFE_GUARDED_DISPATCH_RESULTS.delete(result);
    return true;
  } catch {
    return false;
  }
}

function permitState(
  permit: ProviderCallPermit,
  store?: PostgresOutboxStore,
): PermitState | null {
  if (
    !permit
    || typeof permit !== "object"
    || !Object.isFrozen(permit)
    || Reflect.ownKeys(permit).length !== 0
  ) return null;
  const state = PERMIT_STATES.get(permit) ?? null;
  return state && (store === undefined || state.store === store)
    ? state
    : null;
}

function issueProviderCallPermit(state: PermitState): ProviderCallPermit {
  const permit = Object.freeze({}) as ProviderCallPermit;
  PERMIT_STATES.set(permit, state);
  return permit;
}

function issueCommittedPreparedDispatchReceipt(
  store: PostgresOutboxStore,
  permit: ProviderCallPermit,
): CommittedPreparedDispatchReceipt {
  const runtime = STORE_RUNTIME_STATES.get(store);
  const authority = permitState(permit, store);
  if (
    !runtime?.binding
    || runtime.channel?.binding !== runtime.binding
    || !authority
  ) {
    throw new Error("Committed prepared dispatch authority is invalid.");
  }
  const receipt = Object.freeze({}) as CommittedPreparedDispatchReceipt;
  COMMITTED_RECEIPT_STATES.set(receipt, Object.freeze({
    store,
    binding: runtime.binding,
    envelope: authority.envelope,
    permit,
    view: authority.view,
  }));
  return receipt;
}

export async function authorizeCommittedPreparedDispatch(
  store: PostgresOutboxStore,
  receipt: CommittedPreparedDispatchReceipt,
): Promise<GuardedPreparedDispatch> {
  const channel = STORE_RUNTIME_STATES.get(store)?.channel;
  if (!channel) {
    throw new Error("Mail dispatch store is not initialized.");
  }
  return channel.authorize(receipt);
}

export function discardCommittedPreparedDispatchReceipt(
  store: PostgresOutboxStore,
  permit: ProviderCallPermit,
  receipt: CommittedPreparedDispatchReceipt,
): boolean {
  const channel = STORE_RUNTIME_STATES.get(store)?.channel;
  return channel?.discardReceipt(permit, receipt) ?? false;
}

export function discardGuardedPreparedDispatch(
  store: PostgresOutboxStore,
  permit: ProviderCallPermit,
  guarded: GuardedPreparedDispatch,
): boolean {
  const channel = STORE_RUNTIME_STATES.get(store)?.channel;
  return channel?.discardGuard(permit, guarded) ?? false;
}

async function lockPermitScope(
  client: OutboxPgClient,
  permit: PermitFenceInput,
  wait: boolean,
): Promise<DeliveryScope | null> {
  const expectedScope = deliveryScope({
    operation_id: permit.operationId,
    user_id: permit.userId,
    delivery_scope_key: permit.deliveryScopeKey,
  });
  if (!(await advisoryLock(client, expectedScope.lockKey, wait))) return null;
  const result = await client.query<CandidateRow & ProviderAuthorityRow>(
    `
    select id::text, user_id, operation_id::text, delivery_scope_key, claim_version,
           dispatch_binding_version, dispatch_binding_sha256,
           provider_correlation_version, provider_evidence_version,
           provider_evidence_sha256
    from public.email_outbox
    where id = $1::uuid
      and operation_id = $2::uuid
      and adapter = $6::text
      and provider_call_started = $7::timestamptz
      and user_id is not distinct from $8::text
      and delivery_scope_key = $9::text
      and dispatch_binding_version = $10::text
      and dispatch_binding_sha256 = $11::text
      and provider_correlation_version = $13::text
      and provider_evidence_version is not distinct from $14::text
      and provider_evidence_sha256 is not distinct from $15::text
      and (
        (
          claim_version = $5::integer
          and claim_token = $3::uuid
          and claim_owner = $4::text
          and lease_expires_at = $12::timestamptz
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
    for update
  `,
    [
      permit.id,
      permit.operationId,
      permit.claimToken,
      permit.claimOwner,
      permit.claimVersion,
      permit.adapter,
      permit.providerCallStartedAt,
      expectedScope.userId,
      expectedScope.key,
      permit.bindingVersion,
      permit.bindingSha256,
      permit.leaseExpiresAt,
      permit.providerCorrelationVersion,
      permit.providerEvidenceVersion,
      permit.providerEvidenceSha256,
    ],
  );
  if (result.rows.length !== 1) return null;
  const row = result.rows[0]!;
  const scope = deliveryScope(row);
  return scope.key === expectedScope.key &&
    scope.userId === expectedScope.userId &&
    exactProviderAuthorityRow(row, permit)
    ? scope
    : null;
}
const ACTIVATION_TOKEN = /^[A-Za-z0-9_-]{43}$/;

function canonicalAppOrigin(): string | null {
  const configured =
    process.env.APP_URL ??
    (process.env.NODE_ENV === "production" ? null : "http://localhost:3000");
  if (!configured) return null;

  try {
    const appUrl = new URL(configured);
    const protocolAllowed =
      process.env.NODE_ENV === "production"
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

const REVOCABLE_SOURCE_TEMPLATES = new Set([
  "reset-password",
  "lost-device-proof",
  "session-revocation-requested",
  "inactivity-reminder",
  "inactivity-reminder-followup",
  "inactivity-admin-notice",
  "daily-study-reminder",
  "revision-reminder",
  "goal-reminder",
  "challenge-reminder",
  "weekly-summary",
]);

function templateAuthorityPolicy(template: string) {
  return (TEMPLATE_AUTHORITY_POLICIES as Readonly<
    Record<string, Readonly<{ scope: string }>>
  >)[template] ?? null;
}

async function backupStatusMailAuthorized(
  client: OutboxPgClient,
  outboxId: string,
) {
  const result = await client.query<{ authorized: boolean }>(
    `
    select public.backup_status_mail_authorized($1::uuid) as authorized
  `,
    [outboxId],
  );
  return result.rows.length === 1
    && result.rows[0]!.authorized === true;
}
async function exactAuthorityRow(
  client: OutboxPgClient,
  text: string,
  values: unknown[],
) {
  const result = await client.query(text, values);
  return result.rows.length === 1;
}

async function lockRevocableSourceAuthority(
  client: OutboxPgClient,
  claim: OutboxClaim<EmailOutboxPayload>,
  scope: DeliveryScope,
  authorization: PreparedDispatchStoreInspection,
) {
  if (claim.payload.template === "backup-status") return false;
  const applicationUrl = canonicalAppOrigin() ?? "";
  const parsed = parseRevocableSourceVariables({
    applicationUrl,
    template: claim.payload.template as MailDispatchAuthority["template"],
    templateVersion: claim.payload.templateVersion,
    variables: claim.payload.variables,
  });
  const required = REVOCABLE_SOURCE_TEMPLATES.has(claim.payload.template);
  if (!required) return true;
  if (!parsed || scope.userId === null) return false;

  // Source IDs are untrusted hints until their rows are locked and matched
  // again. They only identify every user row that must be acquired in the
  // canonical ascending order before any revocable source row.
  let sourceUserId = scope.userId;
  if (parsed.kind === "session-revocation-requested") {
    const source = await client.query<{ user_id: string }>(
      `
      select user_id
      from public.session_revocation_request
      where id = $1::uuid
    `,
      [parsed.sourceId],
    );
    if (source.rows.length !== 1 || !source.rows[0]!.user_id) return false;
    sourceUserId = source.rows[0]!.user_id;
  } else if (parsed.kind === "inactivity") {
    const source = await client.query<{ user_id: string }>(
      `
      select user_id
      from public.inactivity_episode
      where id = $1::uuid
    `,
      [parsed.sourceId],
    );
    if (source.rows.length !== 1 || !source.rows[0]!.user_id) return false;
    sourceUserId = source.rows[0]!.user_id;
  }

  const authorityUserIds = [...new Set([scope.userId, sourceUserId])].sort();
  for (const userId of authorityUserIds) {
    if (
      !(await exactAuthorityRow(
        client,
        `
        select id
        from public."user"
        where id = $1::text
        for share
      `,
        [userId],
      ))
    ) return false;
  }

  if (parsed.kind === "reset-password") {
    if (
      !(await exactAuthorityRow(
        client,
        `
        select id
        from public.verification
        where id = $1::text
        for share
      `,
        [parsed.sourceId],
      ))
    ) return false;
  } else if (parsed.kind === "lost-device-proof") {
    const proof = await client.query<{ session_id: string }>(
      `
      select session_id::text
      from public.lost_device_proof
      where id = $1::uuid
      for share
    `,
      [parsed.sourceId],
    );
    if (proof.rows.length !== 1) return false;
    if (
      !(await exactAuthorityRow(
        client,
        `
        select id::text
        from public.session
        where id = $1::text
        for share
      `,
        [proof.rows[0]!.session_id],
      ))
    ) return false;
  } else if (parsed.kind === "session-revocation-requested") {
    if (
      !(await exactAuthorityRow(
        client,
        `
        select id::text
        from public.session_revocation_request
        where id = $1::uuid
          and user_id = $2::text
        for share
      `,
        [parsed.sourceId, sourceUserId],
      ))
    ) return false;
  } else if (parsed.kind === "inactivity") {
    if (
      !(await exactAuthorityRow(
        client,
        `
        select id::text
        from public.inactivity_episode
        where id = $1::uuid
          and user_id = $2::text
        for share
      `,
        [parsed.sourceId, sourceUserId],
      ))
    ) return false;
    const consent = await client.query(
      `
      select id::text
      from public.consent_record
      where user_id = $1::text
        and purpose = 'inactivity_mentor_notice'
      order by occurred_at desc, created_at desc, id desc
      limit 1
      for share
    `,
      [sourceUserId],
    );
    if (consent.rows.length !== 1) return false;
    const preference = await client.query(
      `
      select user_id
      from public.notification_preference
      where user_id = $1::text
      for share
    `,
      [sourceUserId],
    );
    if (preference.rows.length > 1) return false;
  } else if (parsed.kind === "smart-reminder") {
    if (
      !(await exactAuthorityRow(
        client,
        `
        select user_id
        from public.notification_preference
        where user_id = $1::text
        for share
      `,
        [scope.userId],
      ))
    ) return false;
    if (
      !(await exactAuthorityRow(
        client,
        `
        select id::text
        from public.smart_reminder_dispatch
        where id = $1::uuid
        for share
      `,
        [parsed.sourceId],
      ))
    ) return false;
  }

  const clock = await client.query<{ now: Date | string }>(
    "select pg_catalog.statement_timestamp() as now",
  );
  if (clock.rows.length !== 1) return false;
  const now = asDate(clock.rows[0]!.now, "Authority timestamp");
  const query: RevocableSourceAuthorityQuery | null =
    buildRevocableSourceAuthorityQuery({
      applicationUrl,
      authorityEvidence: authorization.authorityEvidence,
      now,
      outboxId: claim.id,
      template: claim.payload.template as MailDispatchAuthority["template"],
      templateVersion: claim.payload.templateVersion,
      variables: claim.payload.variables,
    });
  if (!query) return false;
  const authority = await client.query(query.text, [...query.values]);
  return authority.rows.length === 1;
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

function dispatchBinding(
  value: DispatchBinding,
  adapter: string,
): DispatchBinding {
  const expectedVersion =
    adapter === "gmail"
      ? "gmail-raw-v1"
      : adapter === "console"
        ? "console-json-v1"
        : null;
  if (
    expectedVersion === null ||
    value.bindingVersion !== expectedVersion ||
    !SHA256_HEX.test(value.bindingSha256)
  ) {
    throw new Error("Outbox dispatch binding is invalid.");
  }
  return Object.freeze({
    bindingVersion: value.bindingVersion,
    bindingSha256: value.bindingSha256,
  });
}

type PreparedDispatchAuthorization = Readonly<{
  view: PreparedDispatchStoreView;
  inspection: PreparedDispatchStoreInspection;
}>;

function dispatchStoreInspection(
  store: PostgresOutboxStore,
  view: PreparedDispatchStoreView,
  adapter: string,
  claim: OutboxClaim<EmailOutboxPayload>,
): PreparedDispatchStoreInspection {
  if (!templateAuthorityPolicy(claim.payload.template)) {
    throw new Error("Prepared dispatch template is invalid.");
  }
  const source: PreparedDispatchSource = Object.freeze({
    applicationUrl: canonicalAppOrigin() ?? "",
    outboxId: claim.id,
    operationId: claim.operationId,
    claimToken: claim.claimToken,
    claimOwner: claim.claimOwner,
    claimVersion: claim.claimVersion,
    deliveryScopeKey: claim.deliveryScopeKey,
    recipient: claim.payload.to,
    template: claim.payload.template as MailDispatchAuthority["template"],
    templateVersion: claim.payload.templateVersion,
    variables: Object.freeze({ ...claim.payload.variables }),
  });
  const channel = STORE_RUNTIME_STATES.get(store)?.channel;
  const inspection = channel?.inspect(view) ?? null;
  if (!inspection) {
    throw new Error("Prepared dispatch envelope is invalid.");
  }
  if (
    !Object.isFrozen(view) ||
    !Object.isFrozen(inspection.binding) ||
    !SHA256_HEX.test(inspection.sourceAuthoritySha256) ||
    (inspection.authorityEvidence !== undefined &&
      !Object.isFrozen(inspection.authorityEvidence)) ||
    sourceAuthoritySha256(source, inspection.authorityEvidence) !==
      inspection.sourceAuthoritySha256
  ) {
    throw new Error("Prepared dispatch envelope is invalid.");
  }
  dispatchBinding(inspection.binding, adapter);
  return inspection;
}

function preparedDispatchState(
  store: PostgresOutboxStore,
  envelope: PreparedDispatchEnvelope,
  adapter: string,
  claim: OutboxClaim<EmailOutboxPayload>,
): PreparedDispatchAuthorization {
  const view = preparedDispatchStoreView(envelope);
  if (!view) {
    throw new Error("Prepared dispatch envelope is invalid or already used.");
  }
  return Object.freeze({
    view,
    inspection: dispatchStoreInspection(store, view, adapter, claim),
  });
}
function exactBindingFromRow(
  row: BindingRow,
  adapter: string,
): DispatchBinding | null {
  if (
    !SHA256_HEX.test(row.dispatch_binding_sha256) ||
    (row.dispatch_binding_version !== "gmail-raw-v1" &&
      row.dispatch_binding_version !== "console-json-v1")
  )
    return null;
  return dispatchBinding(
    {
      bindingVersion: row.dispatch_binding_version,
      bindingSha256: row.dispatch_binding_sha256 as ProviderPayloadSha256,
    },
    adapter,
  );
}

function exactProviderAuthorityRow(
  row: ProviderAuthorityRow,
  permit: PermitFenceInput,
): boolean {
  const binding = exactBindingFromRow(row, permit.adapter);
  return binding?.bindingVersion === permit.bindingVersion
    && binding.bindingSha256 === permit.bindingSha256
    && row.provider_correlation_version === permit.providerCorrelationVersion
    && row.provider_evidence_version === permit.providerEvidenceVersion
    && row.provider_evidence_sha256 === permit.providerEvidenceSha256;
}

function exactTerminalFence(
  row: TerminalRow,
  permit: PermitFenceInput,
): boolean {
  try {
    return (
      row.user_id === permit.userId &&
      row.delivery_scope_key === permit.deliveryScopeKey &&
      row.adapter === permit.adapter &&
      row.provider_call_started === permit.providerCallStartedAt &&
      row.claim_token === null &&
      row.claim_owner === null &&
      row.lease_expires_at === null &&
      exactProviderAuthorityRow(row, permit)
    );
  } catch {
    return false;
  }
}

function exactTerminalTimestamp(
  value: Date | string | null,
  name: string,
): boolean {
  if (value === null) return false;
  try {
    return Number.isFinite(asDate(value, name).getTime());
  } catch {
    return false;
  }
}

async function providerBoundaryDecisionAfterBoundary(
  client: OutboxPgClient,
  claim: OutboxClaim<EmailOutboxPayload>,
  permit: PermitFenceInput,
): Promise<BoundaryDecision | null> {
  const deletionEvidence = deletionNoticeCapabilityEvidence(claim.payload);
  const approvedInvitationTokenHash = canonicalActivationTokenHash(claim);
  const adminAccessUrl = canonicalAdminAccessUrl(claim);
  const accountAuthoritySql = accountMailAuthorityPredicate(
    "outbox",
    "for share of account_user",
  );
  const systemAuthoritySql = systemMailAuthorityPredicate("outbox", {
    approvedInvitationTokenHashParameter: 22,
    adminAccessUrlParameter: 23,
    lockAuthorityRows: true,
  });
  const deletionAuthoritySql = deletionNoticeCapabilityPredicate("outbox", {
    recipientHmacParameter: 19,
    payloadDigestParameter: 20,
    validParameter: 21,
  });
  const result = await client.query<{ decision: BoundaryDecision }>(
    `
    select case
      when ${systemAuthoritySql} then 'allowed'
      when outbox.user_id is null then 'SYSTEM_EMAIL_AUTHORITY_INVALID'
      when outbox.template <> ${DELETION_NOTICE_TEMPLATE_SQL}
        and outbox.template <> 'backup-status'
        and ${accountAuthoritySql}
        then 'allowed'
      when ${deletionAuthoritySql} then 'allowed'
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
      and outbox.adapter = $12::text
      and outbox.provider_call_started = $13::timestamptz
      and outbox.dispatch_binding_version = $14::text
      and outbox.dispatch_binding_sha256 = $15::text
      and outbox.provider_correlation_version = $16::text
      and outbox.provider_evidence_version is not distinct from $17::text
      and outbox.provider_evidence_sha256 is not distinct from $18::text
      and outbox.provider_message_id is null
      and outbox.sent_at is null
      and outbox.quarantined_at is null
      and outbox.lease_expires_at > pg_catalog.statement_timestamp()
      and outbox.status = 'sending'
  `,
    [
      claim.id,
      claim.operationId,
      claim.claimToken,
      claim.claimOwner,
      claim.claimVersion,
      claim.deliveryScopeKey,
      claim.userId,
      claim.payload.to,
      claim.payload.template,
      claim.payload.templateVersion,
      JSON.stringify(claim.payload.variables),
      permit.adapter,
      permit.providerCallStartedAt,
      permit.bindingVersion,
      permit.bindingSha256,
      permit.providerCorrelationVersion,
      permit.providerEvidenceVersion,
      permit.providerEvidenceSha256,
      deletionEvidence.recipientHmacSha256,
      deletionEvidence.payloadSha256,
      deletionEvidence.valid,
      approvedInvitationTokenHash,
      adminAccessUrl,
    ],
  );
  return result.rows.length === 1 ? result.rows[0]!.decision : null;
}
function claimFromRow(row: ClaimRow): OutboxClaim<EmailOutboxPayload> {
  assertUuid(row.id, "Outbox ID");
  assertUuid(row.operation_id, "Outbox operation ID");
  const scope = deliveryScope(row);
  assertUuid(row.claim_token, "Outbox claim token");
  const claimOwner = assertBoundedText(
    row.claim_owner,
    "Outbox claim owner",
    128,
  );
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
    userId: scope.userId,
    deliveryScopeKey: scope.key,
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
  const scope = deliveryScope({
    operation_id: claim.operationId,
    user_id: claim.userId,
    delivery_scope_key: claim.deliveryScopeKey,
  });
  if (
    scope.userId !== claim.payload.userId ||
    scope.key !== claim.deliveryScopeKey
  ) {
    throw new Error("Outbox claim scope does not match its payload.");
  }
}

function validatePermit(
  capability: ProviderCallPermit,
  store: PostgresOutboxStore,
): PermitState {
  const permit = permitState(capability, store);
  if (!permit) throw new Error("Outbox provider permit is invalid.");
  assertUuid(permit.id, "Outbox ID");
  assertUuid(permit.operationId, "Outbox operation ID");
  assertUuid(permit.claimToken, "Outbox claim token");
  assertBoundedText(permit.claimOwner, "Outbox claim owner", 128);
  if (!Number.isSafeInteger(permit.claimVersion) || permit.claimVersion <= 0) {
    throw new Error("Outbox claim version must be a positive integer.");
  }
  if (!ADAPTERS.has(permit.adapter))
    throw new Error("Outbox adapter is not allowed.");
  assertBoundedText(
    permit.providerCallStartedAt,
    "Provider boundary timestamp",
    64,
  );
  assertBoundedText(permit.leaseExpiresAt, "Provider lease expiry", 64);
  const scope = deliveryScope({
    operation_id: permit.operationId,
    user_id: permit.userId,
    delivery_scope_key: permit.deliveryScopeKey,
  });
  if (scope.key !== permit.deliveryScopeKey) {
    throw new Error("Outbox permit scope is invalid.");
  }
  dispatchBinding(permit, permit.adapter);
  if (
    !SHA256_HEX.test(permit.sourceAuthoritySha256)
    || (permit.providerEvidenceSha256 !== null
      && !SHA256_HEX.test(permit.providerEvidenceSha256))
    || !permit.providerCorrelationVersion
    || (permit.providerEvidenceVersion !== null
      && !permit.providerEvidenceVersion)
  ) {
    throw new Error("Outbox provider authority tuple is invalid.");
  }
  return permit;
}

export class PostgresOutboxStore implements OutboxStore<EmailOutboxPayload> {
  constructor(
    private readonly pool: OutboxPgPool,
    startupInspection: MailDispatchRuntimeStartupInspection,
  ) {
    if (!isMailDispatchRuntimeStartupInspectionForPool(startupInspection, pool)) {
      throw new Error("Mail dispatch startup inspection is invalid.");
    }
    const runtimePlan = Object.freeze({
      timeouts: Object.freeze({
        oauthDeadlineMs: startupInspection.plan.timeouts.oauthDeadlineMs,
        guardedSendDeadlineMs:
          startupInspection.plan.timeouts.guardedSendDeadlineMs,
        providerAbortSettlementMs:
          startupInspection.plan.timeouts.providerAbortSettlementMs,
      }),
    });
    const state: StoreRuntimeState = {
      startupInspection,
      runtimePlan,
    };
    STORE_RUNTIME_STATES.set(this, state);
    try {
      const channel = createStoreBoundPreparedDispatchChannel(
        this,
        runtimePlan,
      );
      if (state.binding !== channel.binding) {
        throw new Error("Prepared dispatch channel binding is invalid.");
      }
      state.channel = channel;
    } catch (error) {
      STORE_RUNTIME_STATES.delete(this);
      throw error;
    }
  }

  async findGmailReconciliationFence(input: Readonly<{ operationId: string }>) {
    assertUuid(input.operationId, "Outbox operation ID");
    return transaction(this.pool, async (client) => {
      const result = await client.query<ReconciliationRow>(
        `
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
              dispatch_binding_version is null
              and dispatch_binding_sha256 is null
            ) or (
              dispatch_binding_version = 'gmail-raw-v1'
              and dispatch_binding_sha256 ~ '^[0-9a-f]{64}$'
            )
          )
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
      `,
        [input.operationId],
      );
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
          row.claim_token === null &&
          row.claim_owner === null &&
          row.lease_expires_at === null &&
          typeof row.provider_message_id === "string" &&
          row.provider_message_id.trim() !== "" &&
          typeof row.sent_at === "string" &&
          row.quarantined_at === null &&
          row.last_error_code === null
        ) {
          assertBoundedText(
            row.provider_message_id,
            "Provider message ID",
            512,
          );
          assertBoundedText(row.provider_call_started, "Provider boundary", 64);
          assertBoundedText(row.sent_at, "Sent timestamp", 64);
          return { kind: "already-applied" as const };
        }
        return { kind: "not-reconcilable" as const };
      }
      if (
        row.status !== "quarantined" ||
        row.provider_message_id !== null ||
        row.sent_at !== null ||
        row.quarantined_at === null ||
        row.last_error_code === null
      ) {
        return { kind: "not-reconcilable" as const };
      }
      if ((row.claim_token === null) !== (row.claim_owner === null)) {
        throw new Error(
          "Outbox reconciliation claim authority is inconsistent.",
        );
      }
      if (row.claim_token !== null)
        assertUuid(row.claim_token, "Outbox claim token");
      const claimOwner =
        row.claim_owner === null
          ? null
          : assertBoundedText(row.claim_owner, "Outbox claim owner", 128);
      const fence = issueGmailReconciliationFence(this, {
        id: row.id,
        operationId: row.operation_id,
        claimVersion: row.claim_version,
        userId: scope.userId,
        deliveryScopeKey: scope.key,
        claimToken: row.claim_token,
        claimOwner,
        leaseExpiresAt:
          row.lease_expires_at === null
            ? null
            : assertBoundedText(
                row.lease_expires_at,
                "Outbox lease expiry",
                64,
              ),
        adapter: "gmail",
        providerCallStartedAt: assertBoundedText(
          row.provider_call_started,
          "Provider boundary",
          64,
        ),
        ...reconciliationAuthority,
        quarantinedAt: assertBoundedText(row.quarantined_at, "Quarantine timestamp", 64),
        lastErrorCode: assertBoundedText(row.last_error_code, "Outbox error code", 80),
      });
      return { kind: "ready" as const, fence };
    });
  }

  async finalizeGmailReconciliation(input: Readonly<{
    fence: GmailReconciliationFence;
    providerMessageId: string;
    proof: GmailReconciliationProof;
  }>) {
    const { fence } = input;
    if (!consumeGmailReconciliationFence(this, fence)) {
      return { kind: "lost" as const };
    }
    assertUuid(fence.id, "Outbox ID");
    assertUuid(fence.operationId, "Outbox operation ID");
    if (!Number.isSafeInteger(fence.claimVersion) || fence.claimVersion <= 0) {
      throw new Error("Outbox reconciliation claim version is invalid.");
    }
    if (fence.adapter !== "gmail") {
      throw new Error("Outbox adapter is not Gmail.");
    }
    if ((fence.claimToken === null) !== (fence.claimOwner === null)) {
      throw new Error("Outbox reconciliation claim authority is inconsistent.");
    }
    if (fence.claimToken !== null) {
      assertUuid(fence.claimToken, "Outbox claim token");
    }
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
      await advisoryLock(client, scope.lockKey, true);
      const observed = await client.query<CandidateRow>(
        `
        select id::text, user_id, operation_id::text, delivery_scope_key,
               claim_version
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
      if (!updated) return { kind: "lost" as const };
      const exact =
        updated.status === "sent"
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
        && updated.last_error_code === null;
      if (!exact) {
        throw new Error("Gmail reconciliation terminal proof mismatch.");
      }
      return { kind: "applied" as const };
    });
  }
  async claimNext(
    input: Readonly<{ owner: string; token: string; leaseMs: number }>,
  ) {
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

        const claimed = await client.query<ClaimRow>(
          `
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
                  )
                )
            )
          returning id::text, user_id, operation_id::text, delivery_scope_key, claim_version,
                    to_email, template, template_version, variables,
                    claim_token::text, claim_owner, attempt_count, lease_expires_at
        `,
          [
            candidate.id,
            candidate.operation_id,
            candidate.claim_version,
            input.token,
            owner,
            input.leaseMs,
            candidate.user_id,
            scope.key,
          ],
        );
        if (claimed.rows[0]) return claimFromRow(claimed.rows[0]);
      }
      return null;
    });
  }

  async beginProviderCall(
    claim: OutboxClaim<EmailOutboxPayload>,
    input: Readonly<{
      adapter: string;
      envelope: PreparedDispatchEnvelope;
    }>,
  ): Promise<BoundaryResult> {
    validateClaim(claim);
    const adapter = assertBoundedText(input.adapter, "Outbox adapter", 32);
    if (!ADAPTERS.has(adapter))
      throw new Error("Outbox adapter is not allowed.");
    const storeRuntime = STORE_RUNTIME_STATES.get(this);
    if (!storeRuntime?.channel) {
      throw new Error("Mail dispatch store is not initialized.");
    }
    const leaseStampMs =
      storeRuntime.startupInspection.plan.providerLease.providerLeaseStampMs;
    const authorization = preparedDispatchState(
      this,
      input.envelope,
      adapter,
      claim,
    );
    const inspection = authorization.inspection;
    const binding = dispatchBinding(inspection.binding, adapter);
    const deletionEvidence = deletionNoticeCapabilityEvidence(claim.payload);
    const approvedInvitationTokenHash = canonicalActivationTokenHash(claim);
    const adminAccessUrl = canonicalAdminAccessUrl(claim);

    const boundary = await transaction(
      this.pool,
      async (client) => {
        const scope = await lockFenceScope(client, claim, true);
        if (!scope) return { kind: "lost" as const };

        let decision: BoundaryDecision | null =
          claim.payload.template === "backup-status"
            ? (await backupStatusMailAuthorized(client, claim.id)
                ? "allowed"
                : "BACKUP_AUTHORITY_UNAVAILABLE")
            : await providerBoundaryDecision(
                client,
                claim,
                scope,
                deletionEvidence,
                approvedInvitationTokenHash,
                adminAccessUrl,
                true,
              );
        if (decision === null) return { kind: "lost" as const };
        if (
          decision === "allowed"
          && claim.payload.template !== "backup-status"
          && !(await lockRevocableSourceAuthority(
            client,
            claim,
            scope,
            inspection,
          ))
        ) {
          decision = "MAIL_SOURCE_AUTHORITY_INVALID";
        }


        if (decision !== "allowed") {
          const suppressed = await client.query<{ id: string }>(
            `
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
            and outbox.dispatch_binding_version is null
            and outbox.dispatch_binding_sha256 is null
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
                and outbox.template <> 'backup-status'
                and not (${ACCOUNT_MAIL_AUTHORITY_SQL})
              )
              or (
                $7::text = 'SYSTEM_EMAIL_AUTHORITY_INVALID'
                and outbox.user_id is null
                and not (${SUPPRESSION_SYSTEM_MAIL_AUTHORITY_SQL})
              )
              or (
                $7::text = 'MAIL_SOURCE_AUTHORITY_INVALID'
                and outbox.template = any($18::text[])
              )
              or (
                $7::text = 'BACKUP_AUTHORITY_UNAVAILABLE'
                and outbox.template = 'backup-status'
                and not public.backup_status_mail_authorized(outbox.id)
              )
            )

          returning outbox.id::text
        `,
            [
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
              deletionEvidence.recipientHmacSha256,
              deletionEvidence.payloadSha256,
              deletionEvidence.valid,
              approvedInvitationTokenHash,
              adminAccessUrl,
              [...REVOCABLE_SOURCE_TEMPLATES],
            ],
          );
          return suppressed.rows.length === 1
            ? { kind: "suppressed" as const, code: decision }
            : { kind: "lost" as const };
        }

        const result = await client.query<BoundaryRow>(
          `
        update public.email_outbox as outbox
        set provider_call_started = pg_catalog.statement_timestamp(),
            adapter = $6::text,
            lease_expires_at = pg_catalog.statement_timestamp()
              + ($7::integer * interval '1 millisecond'),
            dispatch_binding_version = $19::text,
            dispatch_binding_sha256 = $20::text,
            provider_correlation_version = $21::text,
            provider_evidence_version = $22::text,
            provider_evidence_sha256 = $23::text,
            updated_at = pg_catalog.statement_timestamp()
        where outbox.id = $1::uuid
          and outbox.operation_id = $2::uuid
          and outbox.provider_correlation_version is null
          and outbox.provider_evidence_version is null
          and outbox.provider_evidence_sha256 is null
          and outbox.claim_token = $3::uuid
          and outbox.claim_owner = $4::text
          and outbox.claim_version = $5::integer
          and outbox.adapter is null
          and outbox.dispatch_binding_version is null
          and outbox.dispatch_binding_sha256 is null
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
            (
              outbox.template = 'backup-status'
              and public.backup_status_mail_authorized(outbox.id)
            )
            or ${BOUNDARY_SYSTEM_MAIL_AUTHORITY_SQL}
            or (
              outbox.template <> ${DELETION_NOTICE_TEMPLATE_SQL}
              and outbox.template <> 'backup-status'
              and ${ACCOUNT_MAIL_AUTHORITY_SQL}
            )
            or ${BOUNDARY_DELETION_CAPABILITY_SQL}
          )

        returning outbox.provider_call_started::text as provider_call_started,
                  outbox.lease_expires_at::text as lease_expires_at,
                  outbox.dispatch_binding_version,
                  outbox.dispatch_binding_sha256,
                  outbox.provider_correlation_version,
                  outbox.provider_evidence_version,
                  outbox.provider_evidence_sha256
      `,
          [
            claim.id,
            claim.operationId,
            claim.claimToken,
            claim.claimOwner,
            claim.claimVersion,
            adapter,
            leaseStampMs,
            scope.userId,
            scope.key,
            claim.payload.to,
            claim.payload.template,
            claim.payload.templateVersion,
            JSON.stringify(claim.payload.variables),
            deletionEvidence.recipientHmacSha256,
            deletionEvidence.payloadSha256,
            deletionEvidence.valid,
            approvedInvitationTokenHash,
            adminAccessUrl,
            binding.bindingVersion,
            binding.bindingSha256,
            inspection.providerCorrelationVersion,
            inspection.providerEvidenceVersion,
            inspection.providerEvidenceSha256,
          ],
        );
        if (result.rows.length !== 1) return { kind: "lost" as const };
        const row = result.rows[0]!;
        const persistedBinding = exactBindingFromRow(row, adapter);
        if (
          persistedBinding?.bindingVersion !== binding.bindingVersion ||
          persistedBinding.bindingSha256 !== binding.bindingSha256
          || row.provider_correlation_version !==
            inspection.providerCorrelationVersion
          || row.provider_evidence_version !== inspection.providerEvidenceVersion
          || row.provider_evidence_sha256 !== inspection.providerEvidenceSha256
        ) {
          return { kind: "lost" as const };
        }

        const permit = issueProviderCallPermit(Object.freeze({
          id: claim.id,
          operationId: claim.operationId,
          claimToken: claim.claimToken,
          claimOwner: claim.claimOwner,
          claimVersion: claim.claimVersion,
          userId: scope.userId,
          deliveryScopeKey: scope.key,
          adapter,
          bindingVersion: persistedBinding.bindingVersion,
          bindingSha256: persistedBinding.bindingSha256,
          providerCallStartedAt: assertBoundedText(
            row.provider_call_started,
            "Provider boundary",
            64,
          ),
          leaseExpiresAt: assertBoundedText(
            row.lease_expires_at,
            "Provider lease expiry",
            64,
          ),
          sourceAuthoritySha256: inspection.sourceAuthoritySha256,
          ...(inspection.authorityEvidence
            ? { authorityEvidence: inspection.authorityEvidence }
            : {}),
          providerCorrelationVersion: inspection.providerCorrelationVersion,
          providerEvidenceVersion: inspection.providerEvidenceVersion,
          providerEvidenceSha256: inspection.providerEvidenceSha256,
          store: this,
          envelope: input.envelope,
          view: authorization.view,
        }));
        return { kind: "applied" as const, permit };
      },
      {
        commitUnknown: () => new ProviderBoundaryCommitUnknownError(),
      },
    );

    if (boundary.kind === "applied") {
      return Object.freeze({
        kind: "applied" as const,
        permit: boundary.permit,
        receipt: issueCommittedPreparedDispatchReceipt(this, boundary.permit),
      });
    }
    return boundary;
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
      }>(
        `
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
      `,
        [
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
        ],
      );
      return result.rows[0] ? { kind: "applied" } : { kind: "lost" };
    });
  }

  async dispatchAfterProviderBoundary(
    capability: ProviderCallPermit,
    guarded: GuardedPreparedDispatch,
    armedWatchdog: ArmedMailDispatchHardWatchdog,
  ): Promise<GuardedDispatchResult> {
    const permit = validatePermit(capability, this);
    const runtime = STORE_RUNTIME_STATES.get(this);
    const channel = runtime?.channel;
    if (!runtime || !channel) {
      throw new Error("Mail dispatch store is not initialized.");
    }
    if (!watchdogIsHealthy(armedWatchdog)) {
      return terminateMailDispatchImmediately();
    }
    if (CLAIMED_HARD_WATCHDOGS.has(armedWatchdog)) {
      return terminateMailDispatchImmediately();
    }
    CLAIMED_HARD_WATCHDOGS.set(armedWatchdog, this);
    const safeResult = <T extends GuardedDispatchResult>(result: T): T =>
      issueSafeGuardedDispatchResult(
        this,
        armedWatchdog,
        result,
      );
    if (DISPATCHED_PERMITS.has(capability)) return safeResult({ kind: "lost" });

    const acquireDeadline = createMailDispatchDbDeadline({
      phase: "pool-acquire",
      budgetMs: runtime.startupInspection.plan.timeouts.poolAcquireMs,
    });
    let lease: MailDispatchDbClientLease<OutboxPgClient>;
    try {
      lease = await connectMailDispatchDbWithin({
        pool: this.pool,
        deadline: acquireDeadline,
      });
    } catch {
      return retainLiveTx2OrTerminate(armedWatchdog);
    }

    // The aggregate pre-provider clock starts immediately before BEGIN. Every
    // query shares this same deadline; a deadline destroys the client before
    // any physical provider call can occur.
    const preProviderDeadline = createMailDispatchDbDeadline({
      phase: "pre-provider",
      budgetMs:
        runtime.startupInspection.plan.timeouts.preProviderTx2PhaseBudgetMs,
    });
    const client = deadlineBoundClient(lease, preProviderDeadline);
    let began = false;
    let claim: OutboxClaim<EmailOutboxPayload> | null = null;
    let transactionId: string | null = null;

    try {
      await client.query("begin");
      began = true;
      await client.query(
        `set local lock_timeout = '${runtime.startupInspection.plan.timeouts.lockMs}ms'`,
      );
      await client.query(
        `set local statement_timeout = '${runtime.startupInspection.plan.timeouts.statementMs}ms'`,
      );
      await client.query(
        "set local idle_in_transaction_session_timeout = '0'",
      );
      await client.query("set local transaction_timeout = '0'");

      const scope = deliveryScope({
        operation_id: permit.operationId,
        user_id: permit.userId,
        delivery_scope_key: permit.deliveryScopeKey,
      });
      if (!(await advisoryLock(client, scope.lockKey, true))) {
        await releaseBeforePhysicalInitiation(
          lease,
          preProviderDeadline,
          began,
          armedWatchdog,
        );
        discardGuardOrTerminate(
        channel,
        capability,
        guarded,
        armedWatchdog,
      );
        return safeResult({ kind: "lost" });
      }

      const locked = await client.query<
        ClaimRow & ProviderAuthorityRow & Readonly<{
          adapter: string;
          provider_call_started: string;
          lease_expires_at: string;
          transaction_id: string;
        }>
      >(
        `
        select id::text, user_id, operation_id::text, delivery_scope_key,
               claim_version, to_email, template, template_version, variables,
               claim_token::text, claim_owner, attempt_count,
               lease_expires_at::text, adapter,
               provider_call_started::text,
               pg_catalog.pg_current_xact_id()::text as transaction_id,
               dispatch_binding_version, dispatch_binding_sha256,
               provider_correlation_version, provider_evidence_version,
               provider_evidence_sha256
        from public.email_outbox
        where id = $1::uuid
          and operation_id = $2::uuid
          and claim_token = $3::uuid
          and claim_owner = $4::text
          and claim_version = $5::integer
          and user_id is not distinct from $6::text
          and delivery_scope_key = $7::text
          and adapter = $8::text
          and provider_call_started = $9::timestamptz
          and dispatch_binding_version = $10::text
          and dispatch_binding_sha256 = $11::text
          and lease_expires_at = $12::timestamptz
          and provider_correlation_version = $13::text
          and provider_evidence_version is not distinct from $14::text
          and provider_evidence_sha256 is not distinct from $15::text
          and provider_message_id is null
          and sent_at is null
          and quarantined_at is null
          and last_error_code is null
          and lease_expires_at > pg_catalog.statement_timestamp()
          and status = 'sending'
        for update
      `,
        [
          permit.id,
          permit.operationId,
          permit.claimToken,
          permit.claimOwner,
          permit.claimVersion,
          scope.userId,
          scope.key,
          permit.adapter,
          permit.providerCallStartedAt,
          permit.bindingVersion,
          permit.bindingSha256,
          permit.leaseExpiresAt,
          permit.providerCorrelationVersion,
          permit.providerEvidenceVersion,
          permit.providerEvidenceSha256,
        ],
      );
      if (locked.rows.length !== 1) {
        await releaseBeforePhysicalInitiation(
          lease,
          preProviderDeadline,
          began,
          armedWatchdog,
        );
        discardGuardOrTerminate(
        channel,
        capability,
        guarded,
        armedWatchdog,
      );
        return safeResult({ kind: "lost" });
      }
      const lockedRow = locked.rows[0]!;
      if (
        lockedRow.provider_call_started !== permit.providerCallStartedAt
        || lockedRow.lease_expires_at !== permit.leaseExpiresAt
        || !/^[1-9][0-9]{0,19}$/.test(lockedRow.transaction_id)
        || !exactProviderAuthorityRow(lockedRow, permit)
      ) {
        await releaseBeforePhysicalInitiation(
          lease,
          preProviderDeadline,
          began,
          armedWatchdog,
        );
        discardGuardOrTerminate(
        channel,
        capability,
        guarded,
        armedWatchdog,
      );
        return safeResult({ kind: "lost" });
      }

      transactionId = lockedRow.transaction_id;
      claim = claimFromRow(lockedRow);
      const inspection = dispatchStoreInspection(
        this,
        permit.view,
        permit.adapter,
        claim,
      );
      if (
        inspection.binding.bindingVersion !== permit.bindingVersion
        || inspection.binding.bindingSha256 !== permit.bindingSha256
        || inspection.sourceAuthoritySha256 !== permit.sourceAuthoritySha256
        || inspection.providerCorrelationVersion
          !== permit.providerCorrelationVersion
        || inspection.providerEvidenceVersion !== permit.providerEvidenceVersion
        || inspection.providerEvidenceSha256 !== permit.providerEvidenceSha256
        || inspection.authorityEvidence !== permit.authorityEvidence
      ) {
        await releaseBeforePhysicalInitiation(
          lease,
          preProviderDeadline,
          began,
          armedWatchdog,
        );
        discardGuardOrTerminate(
        channel,
        capability,
        guarded,
        armedWatchdog,
      );
        return safeResult({ kind: "lost" });
      }


      const decision = claim.payload.template === "backup-status"
        ? (await backupStatusMailAuthorized(client, claim.id)
            ? "allowed" as const
            : "BACKUP_AUTHORITY_UNAVAILABLE" as const)
        : await providerBoundaryDecisionAfterBoundary(client, claim, permit);
      const sourceAuthorized = decision === "allowed"
        && (!REVOCABLE_SOURCE_TEMPLATES.has(claim.payload.template)
          || await lockRevocableSourceAuthority(
            client,
            claim,
            scope,
            inspection,
          ));
      if (!sourceAuthorized) {
        await releaseBeforePhysicalInitiation(
          lease,
          preProviderDeadline,
          began,
          armedWatchdog,
        );
        discardGuardOrTerminate(
        channel,
        capability,
        guarded,
        armedWatchdog,
      );
        return safeResult({ kind: "lost" });
      }

      const finalFence = await client.query(
        `
        select 1
        from public.email_outbox
        where id = $1::uuid
          and operation_id = $2::uuid
          and claim_token = $3::uuid
          and claim_owner = $4::text
          and claim_version = $5::integer
          and user_id is not distinct from $6::text
          and delivery_scope_key = $7::text
          and adapter = $8::text
          and provider_call_started = $9::timestamptz
          and dispatch_binding_version = $10::text
          and dispatch_binding_sha256 = $11::text
          and lease_expires_at = $12::timestamptz
          and provider_correlation_version = $13::text
          and provider_evidence_version is not distinct from $14::text
          and provider_evidence_sha256 is not distinct from $15::text
          and to_email = lower(btrim($16::text))
          and template = $17::text
          and template_version = $18::text
          and variables = $19::jsonb
          and provider_message_id is null
          and sent_at is null
          and quarantined_at is null
          and last_error_code is null
          and lease_expires_at > pg_catalog.statement_timestamp()
          and status = 'sending'
        for update
      `,
        [
          permit.id,
          permit.operationId,
          permit.claimToken,
          permit.claimOwner,
          permit.claimVersion,
          permit.userId,
          permit.deliveryScopeKey,
          permit.adapter,
          permit.providerCallStartedAt,
          permit.bindingVersion,
          permit.bindingSha256,
          permit.leaseExpiresAt,
          permit.providerCorrelationVersion,
          permit.providerEvidenceVersion,
          permit.providerEvidenceSha256,
          claim.payload.to,
          claim.payload.template,
          claim.payload.templateVersion,
          JSON.stringify(claim.payload.variables),
        ],
      );
      if (
        finalFence.rows.length !== 1
        || preProviderDeadline.isExpired()
      ) {
        await releaseBeforePhysicalInitiation(
          lease,
          preProviderDeadline,
          began,
          armedWatchdog,
        );
        discardGuardOrTerminate(
        channel,
        capability,
        guarded,
        armedWatchdog,
      );
        return safeResult({ kind: "lost" });
      }
    } catch {
      await releaseBeforePhysicalInitiation(
        lease,
        preProviderDeadline,
        began,
        armedWatchdog,
      );
      discardGuardOrTerminate(
        channel,
        capability,
        guarded,
        armedWatchdog,
      );
      return safeResult({ kind: "lost" });
    }

    if (!transactionId || !watchdogIsHealthy(armedWatchdog)) {
      return terminateMailDispatchImmediately();
    }

    // No finally/catch below this physical-initiation boundary may unwind TX2.
    // The frozen channel validates and burns the guard synchronously, starts the
    // provider call synchronously, and returns the only observable settlement.
    if (DISPATCHED_PERMITS.has(capability)) {
      await releaseBeforePhysicalInitiation(
        lease,
        preProviderDeadline,
        began,
        armedWatchdog,
      );
      discardGuardOrTerminate(
        channel,
        capability,
        guarded,
        armedWatchdog,
      );
      return safeResult({ kind: "lost" });
    }
    DISPATCHED_PERMITS.add(capability);
    const controller = new AbortController();
    let providerOperation: Promise<PostProviderExit>;
    try {
      providerOperation = channel.dispatch(
        capability,
        guarded,
        controller.signal,
      );
    } catch {
      return retainLiveTx2OrTerminate(armedWatchdog);
    }
    const providerDeadlineMs =
      runtime.startupInspection.plan.timeouts.guardedSendDeadlineMs
      + runtime.startupInspection.plan.timeouts.providerAbortSettlementMs
      + runtime.startupInspection.plan.timeouts.fatalExitMarginMs;
    const providerSettlementOperation = observeLiveProviderWithin(
      providerOperation,
      providerDeadlineMs,
      armedWatchdog,
    );

    const postInitiationArmDeadline = createMailDispatchDbDeadline({
      phase: "post-init-arm",
      budgetMs: runtime.startupInspection.plan.timeouts.queryMs,
    });
    const postTimeouts =
      runtime.startupInspection.plan.liveProviderTx2DatabaseTimeouts
        .postProviderInitiation;
    try {
      await queryRetainingLiveTx2({
        client: lease.client,
        deadline: postInitiationArmDeadline,
        text:
          `set local transaction_timeout = '${postTimeouts.transactionTimeoutMs}ms'`,
        watchdog: armedWatchdog,
      });
      await queryRetainingLiveTx2({
        client: lease.client,
        deadline: postInitiationArmDeadline,
        text:
          `set local idle_in_transaction_session_timeout = '${postTimeouts.idleInTransactionSessionTimeoutMs}ms'`,
        watchdog: armedWatchdog,
      });
    } catch {
      return retainLiveTx2OrTerminate(armedWatchdog);
    }

    const providerSettlement = await providerSettlementOperation;

    let exit: PostProviderExit;
    if (providerSettlement.kind === "rejected") {
      exit = Object.freeze({
        kind: "quarantined" as const,
        code: "PROVIDER_OUTCOME_UNKNOWN",
      });
    } else {
      const rawExit = providerSettlement.exit;
      try {
        if (rawExit.kind === "sent") {
          exit = Object.freeze({
            kind: "sent" as const,
            providerMessageId: assertBoundedText(
              rawExit.providerMessageId,
              "Provider message ID",
              512,
            ),
          });
        } else if (
          rawExit.kind === "failed"
          || rawExit.kind === "quarantined"
        ) {
          exit = Object.freeze({
            kind: rawExit.kind,
            code: assertBoundedText(rawExit.code, "Outbox error code", 80),
          });
        } else {
          throw new Error("Provider outcome is invalid.");
        }
      } catch {
        exit = Object.freeze({
          kind: "quarantined" as const,
          code: "PROVIDER_OUTCOME_INVALID",
        });
      }
    }

    const providerMessageId = exit.kind === "sent"
      ? exit.providerMessageId
      : null;
    const code = exit.kind === "sent" ? null : exit.code;
    const postProviderDeadline = createMailDispatchDbDeadline({
      phase: "post-provider",
      budgetMs:
        runtime.startupInspection.plan.timeouts.postProviderTx2PhaseBudgetMs,
    });
    const settledProviderClient: SettledProviderClientState = {
      pool: this.pool,
      client: lease.client,
      transactionId,
      scopeLockKey: deliveryScope({
        operation_id: permit.operationId,
        user_id: permit.userId,
        delivery_scope_key: permit.deliveryScopeKey,
      }).lockKey,
      teardownConfirmationMs:
        runtime.startupInspection.plan.timeouts.watchdogTeardownConfirmationMs,
      closed: false,
      teardownConfirmed: false,
    };

    try {
      const terminal = await queryAfterProviderWithin<TerminalRow>({
        state: settledProviderClient,
        deadline: postProviderDeadline,
        watchdog: armedWatchdog,
        text: `
          update public.email_outbox
          set status = case $15::text
                when 'sent' then 'sent'::public.notification_status
                when 'failed' then 'failed'::public.notification_status
                when 'quarantined' then 'quarantined'::public.notification_status
              end,
              provider_message_id = case when $15::text = 'sent'
                then $16::text else null end,
              sent_at = case when $15::text = 'sent'
                then pg_catalog.statement_timestamp() else null end,
              quarantined_at = case when $15::text = 'quarantined'
                then pg_catalog.statement_timestamp() else null end,
              last_error_code = case when $15::text = 'sent'
                then null else $17::text end,
              claim_version = case when $15::text = 'quarantined'
                then claim_version + 1 else claim_version end,
              claim_token = null,
              claim_owner = null,
              lease_expires_at = null,
              updated_at = pg_catalog.statement_timestamp()
          where id = $1::uuid
            and operation_id = $2::uuid
            and claim_token = $3::uuid
            and claim_owner = $4::text
            and claim_version = $5::integer
            and ($15::text <> 'quarantined' or claim_version < 2147483647)
            and user_id is not distinct from $6::text
            and delivery_scope_key = $7::text
            and adapter = $8::text
            and provider_call_started = $9::timestamptz
            and dispatch_binding_version = $10::text
            and dispatch_binding_sha256 = $11::text
            and provider_correlation_version = $12::text
            and provider_evidence_version is not distinct from $13::text
            and provider_evidence_sha256 is not distinct from $14::text
            and lease_expires_at = $18::timestamptz
            and provider_message_id is null
            and sent_at is null
            and quarantined_at is null
            and last_error_code is null
            and status = 'sending'
          returning status::text, claim_version, user_id, delivery_scope_key,
                    adapter, provider_message_id,
                    provider_call_started::text, sent_at::text,
                    quarantined_at::text, last_error_code, claim_token::text,
                    claim_owner, lease_expires_at::text,
                    dispatch_binding_version, dispatch_binding_sha256,
                    provider_correlation_version, provider_evidence_version,
                    provider_evidence_sha256
        `,
        values: [
          permit.id,
          permit.operationId,
          permit.claimToken,
          permit.claimOwner,
          permit.claimVersion,
          permit.userId,
          permit.deliveryScopeKey,
          permit.adapter,
          permit.providerCallStartedAt,
          permit.bindingVersion,
          permit.bindingSha256,
          permit.providerCorrelationVersion,
          permit.providerEvidenceVersion,
          permit.providerEvidenceSha256,
          exit.kind,
          providerMessageId,
          code,
          permit.leaseExpiresAt,
        ],
      });
      if (terminal.rows.length !== 1) {
        throw new Error("Guarded terminal CAS did not update exactly one row.");
      }
      const row = terminal.rows[0]!;
      const expectedClaimVersion = exit.kind === "quarantined"
        ? permit.claimVersion + 1
        : permit.claimVersion;
      const exactOutcome = row.status === exit.kind
        && row.claim_version === expectedClaimVersion
        && row.provider_message_id === providerMessageId
        && row.last_error_code === code
        && (exit.kind === "sent"
          ? exactTerminalTimestamp(row.sent_at, "Sent timestamp")
          : row.sent_at === null)
        && (exit.kind === "quarantined"
          ? exactTerminalTimestamp(row.quarantined_at, "Quarantine timestamp")
          : row.quarantined_at === null);
      if (!exactTerminalFence(row, permit) || !exactOutcome) {
        throw new Error("Guarded terminal proof mismatch.");
      }

      await queryAfterProviderWithin({
        state: settledProviderClient,
        deadline: postProviderDeadline,
        text: "commit",
        watchdog: armedWatchdog,
      });
    } catch {
      await destroySettledProviderClientOrTerminate(
        settledProviderClient,
        armedWatchdog,
      );
      return safeResult({
        kind: "persistence-unknown" as const,
        uncertainty: issueGuardedDispatchPersistenceUnknown({
          store: this,
          permit: capability,
          exit,
        }),
      });
    }

    // COMMIT ACK is known, so server locks are gone before normal release.
    try {
      settledProviderClient.client.release();
      settledProviderClient.closed = true;
    } catch {
      return retainLiveTx2OrTerminate(armedWatchdog);
    }
    return safeResult({ kind: "applied" as const, exit });
  }


  async finishGuardedDispatchUnknown(
    uncertainty: GuardedDispatchUncertainty,
  ): Promise<GuardedUnknownFinishResult | null> {
    if (
      !uncertainty
      || typeof uncertainty !== "object"
      || !Object.isFrozen(uncertainty)
      || Reflect.ownKeys(uncertainty).length !== 0
    ) return null;
    const state = GUARDED_DISPATCH_UNKNOWN_STATES.get(uncertainty);
    if (!state || state.store !== this) return null;
    GUARDED_DISPATCH_UNKNOWN_STATES.delete(uncertainty);
    const result = await this.finishAuthorizedProviderExit(state.permit, state.exit);
    return Object.freeze({
      result,
      exit: state.exit,
    });
  }

  async finishAfterProvider(
    capability: ProviderCallPermit,
    exit: PostProviderExit,
  ): Promise<PostFinishResult> {
    if (exit.kind === "sent") {
      throw new Error(
        "Sent finalization requires a module-issued guarded-dispatch uncertainty.",
      );
    }
    return this.finishAuthorizedProviderExit(capability, exit);
  }

  private async finishAuthorizedProviderExit(
    capability: ProviderCallPermit,
    exit: PostProviderExit,
  ): Promise<PostFinishResult> {
    const permit = validatePermit(capability, this);
    const providerMessageId =
      exit.kind === "sent"
        ? assertBoundedText(exit.providerMessageId, "Provider message ID", 512)
        : null;
    const code =
      exit.kind === "sent"
        ? null
        : assertBoundedText(exit.code, "Outbox error code", 80);

    return transaction(this.pool, async (client) => {
      const scope = await lockPermitScope(client, permit, true);
      if (!scope) return { kind: "lost" };
      let result =
        exit.kind === "sent"
          ? await client.query<TerminalRow>(
              `
            update public.email_outbox
            set provider_message_id = $7::text,
                sent_at = pg_catalog.statement_timestamp(),
                status = 'sent'::public.notification_status,
                last_error_code = null,
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
              and sent_at is null
              and quarantined_at is null
              and last_error_code is null
              and lease_expires_at = $13::timestamptz
              and provider_call_started = $9::timestamptz
              and status = 'sending'
              and user_id is not distinct from $10::text
              and delivery_scope_key = $8::text
              and dispatch_binding_version = $11::text
              and dispatch_binding_sha256 = $12::text
              and provider_correlation_version = $14::text
              and provider_evidence_version is not distinct from $15::text
              and provider_evidence_sha256 is not distinct from $16::text
            returning status::text, claim_version, user_id, delivery_scope_key,
                      adapter, provider_message_id, provider_call_started, sent_at,
                      quarantined_at, last_error_code, claim_token::text,
                      claim_owner, lease_expires_at, dispatch_binding_version,
                      dispatch_binding_sha256, provider_correlation_version,
                      provider_evidence_version, provider_evidence_sha256
          `,
              [
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
                permit.bindingVersion,
                permit.bindingSha256,
                permit.leaseExpiresAt,
                permit.providerCorrelationVersion,
                permit.providerEvidenceVersion,
                permit.providerEvidenceSha256,
              ],
            )
          : await client.query<TerminalRow>(
              `
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
              and sent_at is null
              and last_error_code is null
              and lease_expires_at = $14::timestamptz
              and provider_call_started = $10::timestamptz
              and quarantined_at is null
              and status = 'sending'
              and user_id is not distinct from $11::text
              and delivery_scope_key = $9::text
              and dispatch_binding_version = $12::text
              and dispatch_binding_sha256 = $13::text
              and provider_correlation_version = $15::text
              and provider_evidence_version is not distinct from $16::text
              and provider_evidence_sha256 is not distinct from $17::text
            returning status::text, claim_version, user_id, delivery_scope_key,
                      adapter, provider_message_id, provider_call_started, sent_at,
                      quarantined_at, last_error_code, claim_token::text,
                      claim_owner, lease_expires_at, dispatch_binding_version,
                      dispatch_binding_sha256, provider_correlation_version,
                      provider_evidence_version, provider_evidence_sha256
          `,
              [
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
                permit.bindingVersion,
                permit.bindingSha256,
                permit.leaseExpiresAt,
                permit.providerCorrelationVersion,
                permit.providerEvidenceVersion,
                permit.providerEvidenceSha256,
              ],
            );

      let updated = result.rows[0];
      let successorFinalized = false;
      if (
        !updated &&
        exit.kind !== "quarantined" &&
        permit.claimVersion < 2147483647
      ) {
        result = await client.query<TerminalRow>(
          `
          update public.email_outbox
          set status = case when $8::text = 'sent'
                then 'sent'::public.notification_status
                else 'failed'::public.notification_status
              end,
              provider_message_id = case when $8::text = 'sent' then $9::text else null end,
              sent_at = case when $8::text = 'sent'
                then pg_catalog.statement_timestamp()
                else null
              end,
              quarantined_at = null,
              last_error_code = case when $8::text = 'sent' then null else $10::text end,
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
            and dispatch_binding_version = $11::text
            and dispatch_binding_sha256 = $12::text
            and provider_correlation_version = $13::text
            and provider_evidence_version is not distinct from $14::text
            and provider_evidence_sha256 is not distinct from $15::text
          returning status::text, claim_version, user_id, delivery_scope_key,
                    adapter, provider_message_id, provider_call_started, sent_at,
                    quarantined_at, last_error_code, claim_token::text,
                    claim_owner, lease_expires_at, dispatch_binding_version,
                    dispatch_binding_sha256, provider_correlation_version,
                    provider_evidence_version, provider_evidence_sha256
        `,
          [
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
            permit.bindingVersion,
            permit.bindingSha256,
            permit.providerCorrelationVersion,
            permit.providerEvidenceVersion,
            permit.providerEvidenceSha256,
          ],
        );
        updated = result.rows[0];
        successorFinalized = updated !== undefined;
      }

      if (updated) {
        const exactOutcome =
          exit.kind === "sent"
            ? successorFinalized
              ? updated.status === "sent" &&
                updated.claim_version === permit.claimVersion + 1 &&
                updated.provider_message_id === providerMessageId &&
                exactTerminalTimestamp(updated.sent_at, "Sent timestamp") &&
                updated.quarantined_at === null &&
                updated.last_error_code === null
              : updated.status === "sent" &&
                updated.claim_version === permit.claimVersion &&
                updated.provider_message_id === providerMessageId &&
                exactTerminalTimestamp(updated.sent_at, "Sent timestamp") &&
                updated.quarantined_at === null &&
                updated.last_error_code === null
            : exit.kind === "failed"
              ? updated.status === "failed" &&
                updated.claim_version ===
                  permit.claimVersion + (successorFinalized ? 1 : 0) &&
                updated.provider_message_id === null &&
                updated.sent_at === null &&
                updated.quarantined_at === null &&
                updated.last_error_code === code
              : !successorFinalized &&
                updated.status === "quarantined" &&
                updated.claim_version === permit.claimVersion + 1 &&
                updated.provider_message_id === null &&
                updated.sent_at === null &&
                exactTerminalTimestamp(
                  updated.quarantined_at,
                  "Quarantine timestamp",
                ) &&
                updated.last_error_code === code;
        if (!exactTerminalFence(updated, permit) || !exactOutcome) {
          throw new PostProviderPersistenceUnknownError(exit);
        }
        return { kind: "applied" };
      }

      const existing = await client.query<TerminalRow>(
        `
        select status::text, claim_version, user_id, delivery_scope_key,
               adapter, provider_message_id, provider_call_started, sent_at,
               quarantined_at, last_error_code, claim_token::text,
               claim_owner, lease_expires_at, dispatch_binding_version,
               dispatch_binding_sha256, provider_correlation_version,
               provider_evidence_version, provider_evidence_sha256
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
          and dispatch_binding_version = $8::text
          and dispatch_binding_sha256 = $9::text
          and provider_correlation_version = $10::text
          and provider_evidence_version is not distinct from $11::text
          and provider_evidence_sha256 is not distinct from $12::text
      `,
        [
          permit.id,
          permit.operationId,
          permit.adapter,
          permit.providerCallStartedAt,
          scope.userId,
          scope.key,
          permit.claimVersion,
          permit.bindingVersion,
          permit.bindingSha256,
          permit.providerCorrelationVersion,
          permit.providerEvidenceVersion,
          permit.providerEvidenceSha256,
        ],
      );
      if (existing.rows.length !== 1) return { kind: "lost" };
      const row = existing.rows[0]!;
      if (!exactTerminalFence(row, permit)) return { kind: "lost" };
      const successorVersion =
        permit.claimVersion < 2147483647 &&
        row.claim_version === permit.claimVersion + 1;
      const exactOutcome =
        exit.kind === "sent"
          ? successorVersion
            ? (
                row.status === "quarantined" &&
                row.provider_message_id === providerMessageId &&
                exactTerminalTimestamp(row.sent_at, "Sent timestamp") &&
                exactTerminalTimestamp(
                  row.quarantined_at,
                  "Quarantine timestamp",
                ) &&
                row.last_error_code === "ABANDONED_POST_PROVIDER_BOUNDARY"
              ) || (
                row.status === "sent" &&
                row.provider_message_id === providerMessageId &&
                exactTerminalTimestamp(row.sent_at, "Sent timestamp") &&
                row.quarantined_at === null &&
                row.last_error_code === null
              )
            : row.claim_version === permit.claimVersion &&
              row.status === "sent" &&
              row.provider_message_id === providerMessageId &&
              exactTerminalTimestamp(row.sent_at, "Sent timestamp") &&
              row.quarantined_at === null &&
              row.last_error_code === null
          : exit.kind === "failed"
            ? (row.claim_version === permit.claimVersion || successorVersion) &&
              row.status === "failed" &&
              row.provider_message_id === null &&
              row.sent_at === null &&
              row.quarantined_at === null &&
              row.last_error_code === code
            : successorVersion &&
              row.status === "quarantined" &&
              row.provider_message_id === null &&
              row.sent_at === null &&
              exactTerminalTimestamp(
                row.quarantined_at,
                "Quarantine timestamp",
              ) &&
              row.last_error_code === code;
      return exactOutcome ? { kind: "already-applied" } : { kind: "lost" };
    });
  }
  async quarantineAbandoned(input: Readonly<{ limit: number }>) {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 500
    ) {
      throw new Error("Outbox sweep limit must be an integer from 1 to 500.");
    }
    return transaction(this.pool, async (client) => {
      const candidates = await client.query<SweepCandidateRow>(
        `
        select id::text, user_id, operation_id::text, delivery_scope_key,
               claim_version, claim_token::text, claim_owner,
               lease_expires_at::text as lease_expires_at, adapter,
               provider_call_started::text, dispatch_binding_version,
               dispatch_binding_sha256
        from public.email_outbox
        where status = 'sending'
          and provider_call_started is not null
          and adapter is not null
          and (
            (dispatch_binding_version is null and dispatch_binding_sha256 is null)
            or (
              dispatch_binding_version is not null
              and dispatch_binding_sha256 is not null
            )
          )
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
      `,
        [input.limit],
      );
      let quarantined = 0;
      for (const candidate of candidates.rows) {
        const scope = deliveryScope(candidate);
        const locked = await advisoryLock(client, scope.lockKey, false);
        if (!locked) continue;
        const result = await client.query<{
          operation_id: string;
          claim_version: number;
          user_id: string | null;
          delivery_scope_key: string;
          adapter: string;
          provider_call_started: Date | string | null;
          claim_token: string | null;
          claim_owner: string | null;
          lease_expires_at: Date | string | null;
          dispatch_binding_version: string | null;
          dispatch_binding_sha256: string | null;
          status: string;
          provider_message_id: string | null;
          sent_at: Date | string | null;
          quarantined_at: Date | string | null;
          last_error_code: string | null;
        }>(
          `
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
            and provider_call_started = $10::timestamptz
            and adapter = $9::text
            and dispatch_binding_version is not distinct from $11::text
            and dispatch_binding_sha256 is not distinct from $12::text
            and provider_message_id is null
            and quarantined_at is null
            and status = 'sending'
          returning operation_id::text, claim_version, user_id,
                    delivery_scope_key, adapter, provider_call_started,
                    claim_token::text, claim_owner, lease_expires_at,
                    dispatch_binding_version, dispatch_binding_sha256,
                    status::text, provider_message_id, sent_at,
                    quarantined_at, last_error_code
        `,
          [
            candidate.id,
            candidate.operation_id,
            candidate.claim_token,
            candidate.claim_owner,
            candidate.claim_version,
            scope.userId,
            candidate.lease_expires_at,
            scope.key,
            candidate.adapter,
            candidate.provider_call_started,
            candidate.dispatch_binding_version,
            candidate.dispatch_binding_sha256,
          ],
        );
        const released = result.rows[0];
        if (released) {
          if (
            released.operation_id !== candidate.operation_id ||
            released.claim_version !== candidate.claim_version + 1 ||
            released.user_id !== scope.userId ||
            released.delivery_scope_key !== scope.key ||
            released.adapter !== candidate.adapter ||
            released.provider_call_started === null ||
            asDate(
              released.provider_call_started,
              "Provider boundary",
            ).getTime() !==
              asDate(
                candidate.provider_call_started,
                "Provider boundary",
              ).getTime() ||
            released.claim_token !== null ||
            released.claim_owner !== null ||
            released.lease_expires_at !== null ||
            released.dispatch_binding_version !==
              candidate.dispatch_binding_version ||
            released.dispatch_binding_sha256 !==
              candidate.dispatch_binding_sha256 ||
            released.status !== "quarantined" ||
            released.provider_message_id !== null ||
            released.sent_at !== null ||
            released.quarantined_at === null ||
            !Number.isFinite(
              asDate(
                released.quarantined_at,
                "Quarantine timestamp",
              ).getTime(),
            ) ||
            released.last_error_code !==
              "ABANDONED_POST_PROVIDER_BOUNDARY"
          ) {
            throw new Error(
              "Abandoned outbox fence did not release at the next generation.",
            );
          }
          quarantined += 1;
        }
      }
      return quarantined;
    });
  }
}
