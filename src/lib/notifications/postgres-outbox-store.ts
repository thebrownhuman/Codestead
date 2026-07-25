import {
  FatalProviderTransportError,
  GuardedDispatchCommitUnknownError,
  PostProviderPersistenceUnknownError,
  ProviderBoundaryCommitUnknownError,
} from "./outbox-worker";
import type {
  BoundaryResult,
  FatalProviderExit,
  GuardedDispatchResult,
  OutboxClaim,
  OutboxStore,
  PostFinishResult,
  PostProviderExit,
  PreFinishResult,
  PreProviderExit,
  ProviderCallPermit,
} from "./outbox-worker";

import type {
  GmailReconciliationDispatchBinding,
  GmailReconciliationFence,
} from "./gmail-reconciliation";
import { userAuthorityLockKey } from "@/lib/security/user-authority-lock";

import {
  PRODUCTION_EMAIL_TEMPLATES,
  TEMPLATE_AUTHORITY_POLICIES,
} from "./template-authority-policy";
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
  dispatchGuardedPrepared,
  guardedDispatchStoreView,
  preparedDispatchStoreView,
  sourceAuthoritySha256,
  type GuardedPreparedDispatch,
  type PreparedDispatchEnvelope,
  type PreparedDispatchSource,
  type PreparedDispatchStoreView,
} from "./guarded-prepared-dispatch";

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

type BindingRow = {
  dispatch_binding_version: string;
  dispatch_binding_sha256: string;
};

type BoundaryRow = BindingRow & {
  provider_call_started: string;
  lease_expires_at: Date | string;
};

type TerminalRow = BindingRow & {
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

type ReconciliationRow = CandidateRow & {
    dispatch_binding_version: string | null;
    dispatch_binding_sha256: string | null;
    claim_token: string | null;
    claim_owner: string | null;
    lease_expires_at: string | null;
    adapter: string;
    status: string;
    provider_call_started: string;
    provider_message_id: string | null;
    sent_at: string | null;
    quarantined_at: string | null;
    last_error_code: string | null;
  };
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
  fatalExit?: FatalProviderExit;
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
    if (error instanceof FatalProviderTransportError) {
      if (options.fatalExit) {
        try {
          options.fatalExit(error);
        } catch {
          // Test and defensive fallback: a production fatalExit never returns.
        }
      }
      destroy = true;
      throw error;
    }
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
    bindingVersion: DispatchBinding["bindingVersion"];
    bindingSha256: ProviderPayloadSha256;
  }>;

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
  const result = await client.query<CandidateRow & BindingRow>(
    `
    select id::text, user_id, operation_id::text, delivery_scope_key, claim_version,
           dispatch_binding_version, dispatch_binding_sha256
    from public.email_outbox
    where id = $1::uuid
      and operation_id = $2::uuid
      and adapter = $6::text
      and provider_call_started = $7::timestamptz
      and user_id is not distinct from $8::text
      and delivery_scope_key = $9::text
      and dispatch_binding_version = $10::text
      and dispatch_binding_sha256 = $11::text
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
    ],
  );
  if (result.rows.length !== 1) return null;
  const row = result.rows[0]!;
  const scope = deliveryScope(row);
  const binding = exactBindingFromRow(row, permit.adapter);
  return scope.key === expectedScope.key &&
    scope.userId === expectedScope.userId &&
    binding?.bindingVersion === permit.bindingVersion &&
    binding.bindingSha256 === permit.bindingSha256
    ? scope
    : null;
}
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

const SMART_REMINDER_TEMPLATES = new Set([
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

function unsupportedGuardedDispatchDecision(
  claim: OutboxClaim<EmailOutboxPayload>,
): BoundaryDecision | null {
  const policy = templateAuthorityPolicy(claim.payload.template);
  if (
    !policy ||
    policy.scope !== "account" ||
    claim.userId === null ||
    claim.payload.template === "backup-status" ||
    claim.payload.template === "session-revocation-requested" ||
    claim.payload.template === "inactivity-admin-notice" ||
    SMART_REMINDER_TEMPLATES.has(claim.payload.template)
  ) {
    return claim.payload.template === "backup-status"
      ? "BACKUP_AUTHORITY_UNAVAILABLE"
      : "MAIL_SOURCE_AUTHORITY_INVALID";
  }
  return null;
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
  authorization: PreparedDispatchStoreView,
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

  // Multi-user revokers remain callback-zero until every writer uses the same
  // signed-advisory/user/request ordering.
  if (
    parsed.kind === "session-revocation-requested" ||
    (parsed.kind === "inactivity" &&
      claim.payload.template === "inactivity-admin-notice")
  )
    return false;

  if (
    !(await exactAuthorityRow(
      client,
      `
    select id
    from public."user"
    where id = $1::text
    order by id
    for share
  `,
      [scope.userId],
    ))
  )
    return false;

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
    )
      return false;
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
    )
      return false;
  } else if (parsed.kind === "inactivity") {
    if (
      !(await exactAuthorityRow(
        client,
        `
      select id::text
      from public.inactivity_episode
      where id = $1::uuid
      for share
    `,
        [parsed.sourceId],
      ))
    )
      return false;
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
      [scope.userId],
    );
    if (consent.rows.length !== 1) return false;
    const preference = await client.query(
      `
      select user_id
      from public.notification_preference
      where user_id = $1::text
      for share
    `,
      [scope.userId],
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
    )
      return false;
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
    )
      return false;
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
  lockAuthorityRows: boolean,
): Promise<BoundaryDecision | null> {
  const accountAuthoritySql = accountMailAuthorityPredicate(
    "outbox",
    lockAuthorityRows ? "for share of account_user" : "",
  );
  const result = await client.query<{ decision: BoundaryDecision }>(
    `
    select case
      when outbox.user_id is not null and ${accountAuthoritySql}
        then 'allowed'
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
  `,
    [
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
    ],
  );
  return result.rows.length === 1 ? result.rows[0]!.decision : null;
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

function dispatchStoreView(
  view: PreparedDispatchStoreView,
  adapter: string,
  claim: OutboxClaim<EmailOutboxPayload>,
): PreparedDispatchStoreView {
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
  if (
    !Object.isFrozen(view) ||
    !Object.isFrozen(view.binding) ||
    !SHA256_HEX.test(view.sourceAuthoritySha256) ||
    (view.authorityEvidence !== undefined &&
      !Object.isFrozen(view.authorityEvidence)) ||
    sourceAuthoritySha256(source, view.authorityEvidence) !==
      view.sourceAuthoritySha256
  ) {
    throw new Error("Prepared dispatch envelope is invalid.");
  }
  dispatchBinding(view.binding, adapter);
  return view;
}

function preparedDispatchState(
  envelope: PreparedDispatchEnvelope,
  adapter: string,
  claim: OutboxClaim<EmailOutboxPayload>,
): PreparedDispatchStoreView {
  const view = preparedDispatchStoreView(envelope);
  if (!view) {
    throw new Error("Prepared dispatch envelope is invalid or already used.");
  }
  return dispatchStoreView(view, adapter, claim);
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
function gmailReconciliationBinding(
  bindingVersion: string | null,
  bindingSha256: string | null,
): GmailReconciliationDispatchBinding | null {
  if (bindingVersion === null && bindingSha256 === null) {
    return Object.freeze({
      kind: "legacy-unbound" as const,
      bindingVersion: null,
      bindingSha256: null,
    });
  }
  if (
    bindingVersion === "gmail-raw-v1" &&
    bindingSha256 !== null &&
    SHA256_HEX.test(bindingSha256)
  ) {
    return Object.freeze({
      kind: "exact-bound" as const,
      bindingVersion,
      bindingSha256: bindingSha256 as ProviderPayloadSha256,
    });
  }
  return null;
}

function exactTerminalFence(
  row: TerminalRow,
  permit: ProviderCallPermit,
): boolean {
  try {
    const binding = exactBindingFromRow(row, permit.adapter);
    return (
      row.user_id === permit.userId &&
      row.delivery_scope_key === permit.deliveryScopeKey &&
      row.adapter === permit.adapter &&
      row.provider_call_started !== null &&
      asDate(row.provider_call_started, "Provider boundary").getTime() ===
        asDate(permit.providerCallStartedAt, "Provider boundary").getTime() &&
      row.claim_token === null &&
      row.claim_owner === null &&
      row.lease_expires_at === null &&
      binding?.bindingVersion === permit.bindingVersion &&
      binding.bindingSha256 === permit.bindingSha256
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
  permit: ProviderCallPermit,
): Promise<BoundaryDecision | null> {
  const accountAuthoritySql = accountMailAuthorityPredicate(
    "outbox",
    "for share of account_user",
  );
  const result = await client.query<{ decision: BoundaryDecision }>(
    `
    select case
      when outbox.user_id is not null and ${accountAuthoritySql}
        then 'allowed'
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
      and outbox.provider_message_id is null
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

function validatePermit(permit: ProviderCallPermit) {
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
  const scope = deliveryScope({
    operation_id: permit.operationId,
    user_id: permit.userId,
    delivery_scope_key: permit.deliveryScopeKey,
  });
  if (scope.key !== permit.deliveryScopeKey) {
    throw new Error("Outbox permit scope is invalid.");
  }
  dispatchBinding(permit, permit.adapter);
}

export class PostgresOutboxStore implements OutboxStore<EmailOutboxPayload> {
  private readonly armedDispatches = new WeakMap<
    ProviderCallPermit,
    Readonly<{
      envelope: PreparedDispatchEnvelope;
      view: PreparedDispatchStoreView;
    }>
  >();

  constructor(private readonly pool: OutboxPgPool) {}

  async findGmailReconciliationFence(input: Readonly<{ operationId: string }>) {
    assertUuid(input.operationId, "Outbox operation ID");
    return transaction(this.pool, async (client) => {
      const result = await client.query<ReconciliationRow>(
        `
        select id::text, user_id, operation_id::text, delivery_scope_key,
               claim_version, claim_token::text, claim_owner,
               lease_expires_at::text, adapter, status::text,
               provider_call_started::text, provider_message_id,
               sent_at::text, quarantined_at::text, last_error_code,
               dispatch_binding_version, dispatch_binding_sha256
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
        row.adapter !== "gmail" ||
        typeof row.provider_call_started !== "string"
      ) {
        return { kind: "not-reconcilable" as const };
      }
      const binding = gmailReconciliationBinding(
        row.dispatch_binding_version,
        row.dispatch_binding_sha256,
      );
      if (!binding) {
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
      const fence: GmailReconciliationFence = {
        ...binding,
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
        quarantinedAt: assertBoundedText(
          row.quarantined_at,
          "Quarantine timestamp",
          64,
        ),
        lastErrorCode: assertBoundedText(
          row.last_error_code,
          "Outbox error code",
          80,
        ),
      };
      return { kind: "ready" as const, fence };
    });
  }

  async finalizeGmailReconciliation(
    input: Readonly<{
      fence: GmailReconciliationFence;
      providerMessageId: string;
      bindingEvidence: GmailReconciliationDispatchBinding;
    }>,
  ) {
    const { fence } = input;
    assertUuid(fence.id, "Outbox ID");
    assertUuid(fence.operationId, "Outbox operation ID");
    if (!Number.isSafeInteger(fence.claimVersion) || fence.claimVersion <= 0) {
      throw new Error("Outbox reconciliation claim version is invalid.");
    }
    if (fence.adapter !== "gmail") {
      throw new Error("Outbox adapter is not Gmail.");
    }
    const fenceBinding = gmailReconciliationBinding(
      fence.bindingVersion,
      fence.bindingSha256,
    );
    const providerBindingEvidence = gmailReconciliationBinding(
      input.bindingEvidence.bindingVersion,
      input.bindingEvidence.bindingSha256,
    );
    if (
      !fenceBinding ||
      !providerBindingEvidence ||
      fenceBinding.kind !== input.bindingEvidence.kind ||
      providerBindingEvidence.kind !== fence.kind ||
      providerBindingEvidence.bindingVersion !== fenceBinding.bindingVersion ||
      providerBindingEvidence.bindingSha256 !== fenceBinding.bindingSha256
    ) {
      throw new Error("Gmail reconciliation binding evidence is invalid.");
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
    const lastErrorCode = assertBoundedText(
      fence.lastErrorCode,
      "Outbox error code",
      80,
    );
    const leaseExpiresAt =
      fence.leaseExpiresAt === null
        ? null
        : assertBoundedText(fence.leaseExpiresAt, "Outbox lease expiry", 64);

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
          and provider_message_id is null
          and sent_at is null
          and status = 'quarantined'
        for update
      `,
        [
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
          providerBindingEvidence.bindingVersion,
          providerBindingEvidence.bindingSha256,
        ],
      );
      const observedRow = observed.rows[0];
      if (!observedRow) {
        const existing = await client.query<{
          status: string;
          claim_version: number;
          user_id: string | null;
          delivery_scope_key: string;
          adapter: string;
          provider_message_id: string | null;
          provider_call_started: Date | string | null;
          sent_at: Date | string | null;
          quarantined_at: Date | string | null;
          last_error_code: string | null;
          claim_token: string | null;
          claim_owner: string | null;
          lease_expires_at: Date | string | null;
          dispatch_binding_version: string | null;
          dispatch_binding_sha256: string | null;
        }>(
          `
          select status::text, claim_version, user_id, delivery_scope_key,
                 adapter, provider_message_id, provider_call_started, sent_at,
                 quarantined_at, last_error_code, claim_token::text,
                 claim_owner, lease_expires_at, dispatch_binding_version,
                 dispatch_binding_sha256
          from public.email_outbox
          where id = $1::uuid
            and operation_id = $2::uuid
            and claim_version = $3::integer
            and user_id is not distinct from $4::text
            and delivery_scope_key = $5::text
            and adapter = $6::text
            and provider_call_started = $7::timestamptz
            and dispatch_binding_version is not distinct from $8::text
            and dispatch_binding_sha256 is not distinct from $9::text
            and status = 'sent'
            and claim_token is null
            and claim_owner is null
            and lease_expires_at is null
            and provider_message_id is not null
            and sent_at is not null
            and quarantined_at is null
            and last_error_code is null
          for update
        `,
          [
            fence.id,
            fence.operationId,
            fence.claimVersion,
            scope.userId,
            scope.key,
            fence.adapter,
            providerCallStartedAt,
            providerBindingEvidence.bindingVersion,
            providerBindingEvidence.bindingSha256,
          ],
        );
        const terminal = existing.rows[0];
        if (!terminal) return { kind: "lost" as const };
        const exactFence =
          terminal.status === "sent" &&
          terminal.claim_version === fence.claimVersion &&
          terminal.user_id === scope.userId &&
          terminal.delivery_scope_key === scope.key &&
          terminal.adapter === fence.adapter &&
          terminal.provider_call_started !== null &&
          asDate(terminal.provider_call_started, "Provider boundary").getTime() ===
            asDate(providerCallStartedAt, "Provider boundary").getTime() &&
          terminal.sent_at !== null &&
          terminal.quarantined_at === null &&
          terminal.last_error_code === null &&
          terminal.claim_token === null &&
          terminal.claim_owner === null &&
          terminal.lease_expires_at === null &&
          terminal.dispatch_binding_version ===
            providerBindingEvidence.bindingVersion &&
          terminal.dispatch_binding_sha256 ===
            providerBindingEvidence.bindingSha256;
        return exactFence && terminal.provider_message_id === providerMessageId
          ? { kind: "already-applied" as const }
          : { kind: "lost" as const };
      }
      const observedScope = deliveryScope(observedRow);
      if (observedScope.key !== scope.key) return { kind: "lost" as const };

      const result = await client.query<{
        status: string;
        claim_version: number;
        user_id: string | null;
        delivery_scope_key: string;
        adapter: string;
        provider_message_id: string | null;
        provider_call_started: Date | string | null;
        sent_at: Date | string | null;
        quarantined_at: Date | string | null;
        last_error_code: string | null;
        claim_token: string | null;
        claim_owner: string | null;
        lease_expires_at: Date | string | null;
        dispatch_binding_version: string | null;
        dispatch_binding_sha256: string | null;
      }>(
        `
        update public.email_outbox
        set status = 'sent',
            provider_message_id = $15::text,
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
          and provider_message_id is null
          and sent_at is null
          and status = 'quarantined'
        returning status::text, claim_version, user_id, delivery_scope_key,
                  adapter, provider_message_id, provider_call_started, sent_at,
                  quarantined_at, last_error_code, claim_token::text,
                  claim_owner, lease_expires_at, dispatch_binding_version,
                  dispatch_binding_sha256
      `,
        [
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
          providerBindingEvidence.bindingVersion,
          providerBindingEvidence.bindingSha256,
          providerMessageId,
        ],
      );
      const updated = result.rows[0];
      const exact =
        updated?.status === "sent" &&
        updated.claim_version === fence.claimVersion &&
        updated.user_id === scope.userId &&
        updated.delivery_scope_key === scope.key &&
        updated.adapter === fence.adapter &&
        updated.provider_message_id === providerMessageId &&
        updated.provider_call_started !== null &&
        asDate(updated.provider_call_started, "Provider boundary").getTime() ===
          asDate(providerCallStartedAt, "Provider boundary").getTime() &&
        updated.sent_at !== null &&
        updated.quarantined_at === null &&
        updated.last_error_code === null &&
        updated.claim_token === null &&
        updated.claim_owner === null &&
        updated.lease_expires_at === null &&
        updated.dispatch_binding_version ===
          providerBindingEvidence.bindingVersion &&
        updated.dispatch_binding_sha256 ===
          providerBindingEvidence.bindingSha256;
      return exact ? { kind: "applied" as const } : { kind: "lost" as const };
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
      leaseMs: number;
      envelope: PreparedDispatchEnvelope;
    }>,
  ): Promise<BoundaryResult> {
    validateClaim(claim);
    const adapter = assertBoundedText(input.adapter, "Outbox adapter", 32);
    if (!ADAPTERS.has(adapter))
      throw new Error("Outbox adapter is not allowed.");
    assertLeaseMs(input.leaseMs);
    const authorization = preparedDispatchState(
      input.envelope,
      adapter,
      claim,
    );
    const binding = dispatchBinding(authorization.binding, adapter);

    const boundary = await transaction(
      this.pool,
      async (client) => {
        const scope = await lockFenceScope(client, claim, true);
        if (!scope) return { kind: "lost" as const };

        let decision = claim.payload.template === "backup-status"
          ? (await backupStatusMailAuthorized(client, claim.id)
              ? "allowed" as const
              : "BACKUP_AUTHORITY_UNAVAILABLE" as const)
          : unsupportedGuardedDispatchDecision(claim);
        if (
          decision === null
          && claim.payload.template !== "backup-status"
        ) {
          decision = await providerBoundaryDecision(
            client,
            claim,
            scope,
            true,
          );
          if (decision === null) return { kind: "lost" as const };
          if (
            decision === "allowed" &&
            !(await lockRevocableSourceAuthority(
              client,
              claim,
              scope,
              authorization,
            ))
          ) {
            decision = "MAIL_SOURCE_AUTHORITY_INVALID";
          }
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
            dispatch_binding_version = $8::text,
            dispatch_binding_sha256 = $9::text,
            updated_at = pg_catalog.statement_timestamp()
        where outbox.id = $1::uuid
          and outbox.operation_id = $2::uuid
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
          and outbox.user_id is not distinct from $10::text
          and outbox.delivery_scope_key = $11::text
          and outbox.to_email = lower(btrim($12::text))
          and outbox.template = $13::text
          and outbox.template_version = $14::text
          and outbox.variables = $15::jsonb

        returning outbox.provider_call_started::text as provider_call_started,
                  outbox.lease_expires_at,
                  outbox.dispatch_binding_version,
                  outbox.dispatch_binding_sha256
      `,
          [
            claim.id,
            claim.operationId,
            claim.claimToken,
            claim.claimOwner,
            claim.claimVersion,
            adapter,
            input.leaseMs,
            binding.bindingVersion,
            binding.bindingSha256,
            scope.userId,
            scope.key,
            claim.payload.to,
            claim.payload.template,
            claim.payload.templateVersion,
            JSON.stringify(claim.payload.variables),
          ],
        );
        if (result.rows.length !== 1) return { kind: "lost" as const };
        const row = result.rows[0]!;
        const persistedBinding = exactBindingFromRow(row, adapter);
        if (
          persistedBinding?.bindingVersion !== binding.bindingVersion ||
          persistedBinding.bindingSha256 !== binding.bindingSha256
        )
          return { kind: "lost" as const };

        const permit = Object.freeze({
          phase: "post-provider" as const,
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
          leaseExpiresAt: asDate(row.lease_expires_at, "Provider lease expiry"),
        }) as ProviderCallPermit;
        return { kind: "applied" as const, permit };
      },
      {
        commitUnknown: () => new ProviderBoundaryCommitUnknownError(),
      },
    );

    if (boundary.kind === "applied") {
      this.armedDispatches.set(boundary.permit, Object.freeze({
        envelope: input.envelope,
        view: authorization,
      }));
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
    permit: ProviderCallPermit,
    guarded: GuardedPreparedDispatch,
    fatalExit: FatalProviderExit,
  ): Promise<GuardedDispatchResult> {
    validatePermit(permit);
    if (typeof fatalExit !== "function") {
      throw new Error("Guarded dispatch fatalExit must be callable.");
    }
    const armed = this.armedDispatches.get(permit);
    const guardedView = guardedDispatchStoreView(guarded);
    if (
      !armed ||
      !guardedView ||
      guardedView.envelope !== armed.envelope ||
      guardedView.dispatch !== armed.view
    ) {
      return { kind: "lost" };
    }

    let callbackExit: PostProviderExit | null = null;
    const result = await transaction(
      this.pool,
      async (client) => {
        const tx2WorkStartedAt = performance.now();
        await client.query("set local lock_timeout = '3s'");
        await client.query("set local statement_timeout = '5s'");
        // A server-side idle/transaction timeout must not release TX2 locks
        // while a live provider request is awaiting its in-process fatalExit.
        await client.query(
          "set local idle_in_transaction_session_timeout = '0'",
        );
        const version = await client.query<{ server_version_num: number }>(
          "select current_setting('server_version_num')::integer as server_version_num",
        );
        if (version.rows.length !== 1) {
          throw new Error("PostgreSQL server version is unavailable.");
        }
        if (version.rows[0]!.server_version_num >= 170000) {
          await client.query("set local transaction_timeout = '0'");
        }

        const scope = deliveryScope({
          operation_id: permit.operationId,
          user_id: permit.userId,
          delivery_scope_key: permit.deliveryScopeKey,
        });
        await advisoryLock(client, scope.lockKey, true);
        const locked = await client.query<
          ClaimRow &
            BindingRow & {
              adapter: string;
              provider_call_started: string;
            }
        >(
          `
        select id::text, user_id, operation_id::text, delivery_scope_key,
               claim_version, to_email, template, template_version, variables,
               claim_token::text, claim_owner, attempt_count, lease_expires_at,
               adapter, provider_call_started::text,
               dispatch_binding_version, dispatch_binding_sha256
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
          and provider_message_id is null
          and sent_at is null
          and quarantined_at is null
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
          ],
        );
        if (locked.rows.length !== 1) return { kind: "lost" as const };
        const claim = claimFromRow(locked.rows[0]!);
        const authorization = dispatchStoreView(
          guardedView.dispatch,
          permit.adapter,
          claim,
        );
        if (
          authorization.binding.bindingVersion !== permit.bindingVersion ||
          authorization.binding.bindingSha256 !== permit.bindingSha256
        )
          return { kind: "lost" as const };

        if (
          claim.userId === null ||
          claim.payload.template === "account-deleted" ||
          claim.payload.template === "session-revocation-requested" ||
          claim.payload.template === "inactivity-admin-notice" ||
          SMART_REMINDER_TEMPLATES.has(claim.payload.template)
        )
          return { kind: "lost" as const };
        const decision = claim.payload.template === "backup-status"
          ? (await backupStatusMailAuthorized(client, claim.id)
              ? "allowed" as const
              : "BACKUP_AUTHORITY_UNAVAILABLE" as const)
          : await providerBoundaryDecisionAfterBoundary(
              client,
              claim,
              permit,
            );
        if (
          decision !== "allowed" ||
          claim.userId === null ||
          claim.payload.template === "account-deleted" ||
          claim.payload.template === "session-revocation-requested" ||
          claim.payload.template === "inactivity-admin-notice" ||
          (REVOCABLE_SOURCE_TEMPLATES.has(claim.payload.template) &&
            !(await lockRevocableSourceAuthority(
              client,
              claim,
              scope,
              authorization,
            )))
        )
          return { kind: "lost" as const };

        if (performance.now() - tx2WorkStartedAt > 5_000) {
          return { kind: "lost" as const };
        }
        const liveFence = await client.query(
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
            and to_email = lower(btrim($12::text))
            and template = $13::text
            and template_version = $14::text
            and variables = $15::jsonb
            and provider_message_id is null
            and sent_at is null
            and quarantined_at is null
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
            claim.payload.to,
            claim.payload.template,
            claim.payload.templateVersion,
            JSON.stringify(claim.payload.variables),
          ],
        );
        if (liveFence.rows.length !== 1) return { kind: "lost" as const };
        if (performance.now() - tx2WorkStartedAt > 5_000) {
          return { kind: "lost" as const };
        }
        if (!this.armedDispatches.delete(permit)) {
          return { kind: "lost" as const };
        }
        const controller = new AbortController();
        let abortTimer: ReturnType<typeof setTimeout> | undefined;
        let hardTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          const callback = dispatchGuardedPrepared(guarded, controller.signal);
          abortTimer = setTimeout(() => controller.abort(), 25_000);
          abortTimer.unref?.();
          const hardDeadline = new Promise<never>((_resolve, reject) => {
            hardTimer = setTimeout(() => {
              reject(
                new FatalProviderTransportError(
                  "PROVIDER_CALLBACK_DID_NOT_SETTLE",
                ),
              );
            }, 30_000);
            hardTimer.unref?.();
          });
          callbackExit = await Promise.race([callback, hardDeadline]);
        } catch (error) {
          if (error instanceof FatalProviderTransportError) throw error;
          callbackExit = {
            kind: "quarantined",
            code: "PROVIDER_OUTCOME_UNKNOWN",
          };
        } finally {
          if (abortTimer !== undefined) clearTimeout(abortTimer);
          if (hardTimer !== undefined) clearTimeout(hardTimer);
        }
        const rawExit = callbackExit;
        let providerMessageId: string | null;
        let code: string | null;
        let exit: PostProviderExit;
        try {
          if (
            !rawExit ||
            !["sent", "failed", "quarantined"].includes(rawExit.kind)
          ) {
            throw new Error("Invalid callback result.");
          }
          providerMessageId =
            rawExit.kind === "sent"
              ? assertBoundedText(
                  rawExit.providerMessageId,
                  "Provider message ID",
                  512,
                )
              : null;
          code =
            rawExit.kind === "sent"
              ? null
              : assertBoundedText(rawExit.code, "Outbox error code", 80);
          exit =
            rawExit.kind === "sent"
              ? { kind: "sent", providerMessageId: providerMessageId! }
              : { kind: rawExit.kind, code: code! };
          callbackExit = exit;
        } catch {
          providerMessageId = null;
          code = "PROVIDER_OUTCOME_INVALID";
          exit = { kind: "quarantined", code };
          callbackExit = exit;
        }
        let terminal;
        try {
          terminal = await client.query<TerminalRow>(
            `
          update public.email_outbox
          set status = case $12::text
                when 'sent' then 'sent'::public.notification_status
                when 'failed' then 'failed'::public.notification_status
                when 'quarantined' then 'quarantined'::public.notification_status
              end,
              provider_message_id = case when $12::text = 'sent'
                then $13::text else null end,
              sent_at = case when $12::text = 'sent'
                then pg_catalog.statement_timestamp() else null end,
              quarantined_at = case when $12::text = 'quarantined'
                then pg_catalog.statement_timestamp() else null end,
              last_error_code = case when $12::text = 'sent'
                then null else $14::text end,
              claim_version = case when $12::text = 'quarantined'
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
            and ($12::text <> 'quarantined' or claim_version < 2147483647)
            and user_id is not distinct from $6::text
            and delivery_scope_key = $7::text
            and adapter = $8::text
            and provider_call_started = $9::timestamptz
            and dispatch_binding_version = $10::text
            and dispatch_binding_sha256 = $11::text
            and provider_message_id is null
            and sent_at is null
            and quarantined_at is null
            and status = 'sending'
          returning status::text, claim_version, user_id, delivery_scope_key,
                    adapter, provider_message_id, provider_call_started, sent_at,
                    quarantined_at, last_error_code, claim_token::text,
                    claim_owner, lease_expires_at, dispatch_binding_version,
                    dispatch_binding_sha256
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
              exit.kind,
              providerMessageId,
              code,
            ],
          );
        } catch {
          throw new PostProviderPersistenceUnknownError(exit);
        }
        if (terminal.rows.length !== 1) {
          throw new PostProviderPersistenceUnknownError(exit);
        }
        try {
          const row = terminal.rows[0]!;
          const persistedBinding = exactBindingFromRow(row, permit.adapter);
          const expectedVersion =
            exit.kind === "quarantined"
              ? permit.claimVersion + 1
              : permit.claimVersion;
          const providerBoundaryMatches =
            row.provider_call_started !== null &&
            asDate(row.provider_call_started, "Provider boundary").getTime() ===
              asDate(permit.providerCallStartedAt, "Provider boundary").getTime();
          const sentShape =
            exit.kind === "sent"
              ? row.sent_at !== null &&
                Number.isFinite(asDate(row.sent_at, "Sent timestamp").getTime())
              : row.sent_at === null;
          const quarantineShape =
            exit.kind === "quarantined"
              ? row.quarantined_at !== null &&
                Number.isFinite(
                  asDate(row.quarantined_at, "Quarantine timestamp").getTime(),
                )
              : row.quarantined_at === null;
          const exact =
            row.status === exit.kind &&
            row.claim_version === expectedVersion &&
            row.user_id === permit.userId &&
            row.delivery_scope_key === permit.deliveryScopeKey &&
            row.adapter === permit.adapter &&
            row.provider_message_id === providerMessageId &&
            providerBoundaryMatches &&
            sentShape &&
            quarantineShape &&
            row.last_error_code === code &&
            row.claim_token === null &&
            row.claim_owner === null &&
            row.lease_expires_at === null &&
            persistedBinding?.bindingVersion === permit.bindingVersion &&
            persistedBinding.bindingSha256 === permit.bindingSha256;
          if (!exact) throw new Error("Guarded terminal proof mismatch.");
        } catch {
          throw new PostProviderPersistenceUnknownError(exit);
        }
        return { kind: "applied" as const, exit };
      },
      {
        commitUnknown: (outcome) =>
          outcome.kind === "applied"
            ? new GuardedDispatchCommitUnknownError(outcome.exit)
            : new Error("Guarded dispatch commit result is unknown."),
        destroyOnWorkError: true,
        fatalExit,
      },
    );

    if (result.kind === "lost") {
      this.armedDispatches.delete(permit);
    }
    return result;
  }
  async finishAfterProvider(
    permit: ProviderCallPermit,
    exit: PostProviderExit,
  ): Promise<PostFinishResult> {
    validatePermit(permit);
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
              and provider_call_started = $9::timestamptz
              and status = 'sending'
              and user_id is not distinct from $10::text
              and delivery_scope_key = $8::text
              and dispatch_binding_version = $11::text
              and dispatch_binding_sha256 = $12::text
            returning status::text, claim_version, user_id, delivery_scope_key,
                      adapter, provider_message_id, provider_call_started, sent_at,
                      quarantined_at, last_error_code, claim_token::text,
                      claim_owner, lease_expires_at, dispatch_binding_version,
                      dispatch_binding_sha256
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
              and provider_call_started = $10::timestamptz
              and quarantined_at is null
              and status = 'sending'
              and user_id is not distinct from $11::text
              and delivery_scope_key = $9::text
              and dispatch_binding_version = $12::text
              and dispatch_binding_sha256 = $13::text
            returning status::text, claim_version, user_id, delivery_scope_key,
                      adapter, provider_message_id, provider_call_started, sent_at,
                      quarantined_at, last_error_code, claim_token::text,
                      claim_owner, lease_expires_at, dispatch_binding_version,
                      dispatch_binding_sha256
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
          returning status::text, claim_version, user_id, delivery_scope_key,
                    adapter, provider_message_id, provider_call_started, sent_at,
                    quarantined_at, last_error_code, claim_token::text,
                    claim_owner, lease_expires_at, dispatch_binding_version,
                    dispatch_binding_sha256
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
        return exactTerminalFence(updated, permit) && exactOutcome
          ? { kind: "applied" }
          : { kind: "lost" };
      }

      const existing = await client.query<TerminalRow>(
        `
        select status::text, claim_version, user_id, delivery_scope_key,
               adapter, provider_message_id, provider_call_started, sent_at,
               quarantined_at, last_error_code, claim_token::text,
               claim_owner, lease_expires_at, dispatch_binding_version,
               dispatch_binding_sha256
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
