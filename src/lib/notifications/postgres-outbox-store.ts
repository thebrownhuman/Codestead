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

import { userAuthorityLockKey } from "@/lib/security/user-authority-lock";
import {
  accountDeletionNoticeBinding,
  ACCOUNT_DELETION_NOTICE_TEMPLATE,
  ACCOUNT_DELETION_NOTICE_TEMPLATE_VERSION,
  deletionNoticeSecret,
  type AccountDeletionNoticeVariables,
} from "./deletion-notice-capability";

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
  provider_call_started: Date | string;
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
  lease_expires_at: Date | string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
    payload.template !== ACCOUNT_DELETION_NOTICE_TEMPLATE
    || payload.templateVersion !== ACCOUNT_DELETION_NOTICE_TEMPLATE_VERSION
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

function accountMailAuthorityPredicate(outbox: string) {
  return `exists (
    select 1 from public."user" account_user
    where account_user.id = ${outbox}.user_id
      and lower(btrim(account_user.email)) = ${outbox}.to_email
      and (
        (
          ${outbox}.template = 'verify-email'
          and account_user.status = 'pending'
        )
        or (
          ${outbox}.template = 'reset-password'
          and account_user.status in ('pending', 'active')
        )
        or (
          ${outbox}.template not in (
            'verify-email', 'reset-password', 'invitation',
            'access-rejected', 'account-deleted'
          )
          and account_user.status = 'active'
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
  return `(
    $${input.validParameter}::boolean
    and ${outbox}.user_id is not null
    and ${outbox}.template = 'account-deleted'
    and ${outbox}.template_version = '1'
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

type PermitFenceInput = ClaimFenceInput & Readonly<{ adapter: string }>;

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
      and claim_version = $5::integer
      and adapter = $6::text
      and provider_call_started is not null
      and (
        (claim_token = $3::uuid and claim_owner = $4::text)
        or (
          claim_token is null
          and claim_owner is null
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
  ]);
  const row = result.rows[0];
  if (!row) return null;
  const scope = deliveryScope(row);
  return await advisoryLock(client, scope.lockKey, wait) ? scope : null;
}

async function providerBoundaryDecision(
  client: OutboxPgClient,
  claim: OutboxClaim<EmailOutboxPayload>,
  scope: DeliveryScope,
  evidence: DeletionNoticeCapabilityEvidence,
): Promise<BoundaryDecision | null> {
  const result = await client.query<{ decision: BoundaryDecision }>(`
    select case
      when outbox.user_id is null
        and outbox.template <> 'account-deleted'
        then 'allowed'
      when outbox.template <> 'account-deleted'
        and ${ACCOUNT_MAIL_AUTHORITY_SQL}
        then 'allowed'
      when ${DECISION_DELETION_CAPABILITY_SQL} then 'allowed'
      when outbox.template = 'account-deleted'
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
}

export class PostgresOutboxStore implements OutboxStore<EmailOutboxPayload> {
  constructor(private readonly pool: OutboxPgPool) {}

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
          where (
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
            and user_id is not distinct from $7::text
            and delivery_scope_key = $8::text
            and claim_version < 2147483647
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

    return transaction(this.pool, async (client) => {
      const scope = await lockFenceScope(client, claim, true);
      if (!scope) return { kind: "lost" };

      const decision = await providerBoundaryDecision(client, claim, scope, evidence);
      if (decision === null) return { kind: "lost" };
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
                and outbox.template = 'account-deleted'
                and not (${SUPPRESSION_DELETION_CAPABILITY_SQL})
              )
              or (
                $7::text = 'ACCOUNT_NOT_ACTIVE_AT_PROVIDER_BOUNDARY'
                and outbox.user_id is not null
                and outbox.template <> 'account-deleted'
                and not (${ACCOUNT_MAIL_AUTHORITY_SQL})
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
            (
              outbox.user_id is null
              and outbox.template <> 'account-deleted'
            )
            or (
              outbox.template <> 'account-deleted'
              and ${ACCOUNT_MAIL_AUTHORITY_SQL}
            )
            or ${BOUNDARY_DELETION_CAPABILITY_SQL}
          )
        returning outbox.provider_call_started, outbox.lease_expires_at
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
        providerCallStartedAt: asDate(row.provider_call_started, "Provider boundary"),
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
      const result = await client.query<{ operation_id: string }>(`
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
      const result = exit.kind === "sent"
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
              and provider_call_started is not null
              and status in ('sending', 'quarantined')
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
              and provider_call_started is not null
              and quarantined_at is null
              and status = 'sending'
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
          ]);
      if (result.rows[0]) return { kind: "applied" };

      const existing = await client.query<TerminalRow>(`
        select status::text, claim_version, adapter, provider_message_id,
               provider_call_started, sent_at, quarantined_at, last_error_code
        from public.email_outbox
        where id = $1::uuid and operation_id = $2::uuid
          and delivery_scope_key = $3::text
      `, [permit.id, permit.operationId, scope.key]);
      const row = existing.rows[0];
      if (!row || row.claim_version !== permit.claimVersion || row.adapter !== permit.adapter) {
        return { kind: "lost" };
      }
      if (
        exit.kind === "sent"
        && (row.status === "sent" || row.status === "quarantined")
        && row.provider_message_id === providerMessageId
        && row.provider_call_started !== null
        && row.sent_at !== null
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
               claim_token::text, claim_owner, lease_expires_at
        from public.email_outbox
        where status = 'sending'
          and provider_call_started is not null
          and adapter is not null
          and provider_message_id is null
          and quarantined_at is null
          and lease_expires_at < pg_catalog.statement_timestamp() - interval '30 seconds'
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
        const result = await client.query<{ operation_id: string }>(`
          update public.email_outbox
          set status = 'quarantined',
              quarantined_at = pg_catalog.statement_timestamp(),
              last_error_code = 'ABANDONED_POST_PROVIDER_BOUNDARY',
              updated_at = pg_catalog.statement_timestamp()
          where id = $1::uuid
            and operation_id = $2::uuid
            and claim_token = $3::uuid
            and claim_owner = $4::text
            and claim_version = $5::integer
            and user_id is not distinct from $6::text
            and delivery_scope_key = $8::text
            and lease_expires_at = $7::timestamptz
            and lease_expires_at < pg_catalog.statement_timestamp() - interval '30 seconds'
            and provider_call_started is not null
            and adapter is not null
            and provider_message_id is null
            and quarantined_at is null
            and status = 'sending'
          returning operation_id::text
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
        if (result.rows[0]) quarantined += 1;
      }
      return quarantined;
    });
  }
}
