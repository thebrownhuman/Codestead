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

function accountLockKey(userId: string | null, operationId: string) {
  return userId
    ? `learncoding/account/v1:${userId}`
    : `learncoding/outbox/v1:${operationId}`;
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
      "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
      [key],
    );
    return true;
  }
  const result = await client.query<{ locked: boolean }>(
    "select pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended($1, 0)) as locked",
    [key],
  );
  return result.rows[0]?.locked === true;
}

function claimFromRow(row: ClaimRow): OutboxClaim<EmailOutboxPayload> {
  assertUuid(row.id, "Outbox ID");
  assertUuid(row.operation_id, "Outbox operation ID");
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
        select id::text, user_id, operation_id::text, claim_version
        from public.email_outbox
        where (
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
        order by next_attempt_at, created_at, id
        limit 16
      `);

      for (const candidate of candidates.rows) {
        const locked = await advisoryLock(
          client,
          accountLockKey(candidate.user_id, candidate.operation_id),
          false,
        );
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
          returning id::text, user_id, operation_id::text, claim_version,
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

    return transaction(this.pool, async (client) => {
      await advisoryLock(client, accountLockKey(claim.payload.userId, claim.operationId), true);
      const result = await client.query<BoundaryRow>(`
        update public.email_outbox
        set provider_call_started = pg_catalog.statement_timestamp(),
            adapter = $6::text,
            lease_expires_at = pg_catalog.statement_timestamp() + ($7::integer * interval '1 millisecond'),
            updated_at = pg_catalog.statement_timestamp()
        where id = $1::uuid
          and operation_id = $2::uuid
          and claim_token = $3::uuid
          and claim_owner = $4::text
          and claim_version = $5::integer
          and adapter is null
          and provider_message_id is null
          and provider_call_started is null
          and quarantined_at is null
          and lease_expires_at > pg_catalog.statement_timestamp()
          and status = 'sending'
          and user_id is not distinct from $8::text
        returning provider_call_started, lease_expires_at
      `, [
        claim.id,
        claim.operationId,
        claim.claimToken,
        claim.claimOwner,
        claim.claimVersion,
        adapter,
        input.leaseMs,
        claim.payload.userId,
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
      await advisoryLock(client, accountLockKey(claim.payload.userId, claim.operationId), true);
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
        claim.payload.userId,
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
      await advisoryLock(client, accountLockKey(null, permit.operationId), true);
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
          ]);
      if (result.rows[0]) return { kind: "applied" };

      const existing = await client.query<TerminalRow>(`
        select status::text, claim_version, adapter, provider_message_id,
               provider_call_started, sent_at, quarantined_at, last_error_code
        from public.email_outbox
        where id = $1::uuid and operation_id = $2::uuid
      `, [permit.id, permit.operationId]);
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
        select id::text, user_id, operation_id::text, claim_version,
               claim_token::text, claim_owner, lease_expires_at
        from public.email_outbox
        where status = 'sending'
          and provider_call_started is not null
          and adapter is not null
          and provider_message_id is null
          and quarantined_at is null
          and lease_expires_at < pg_catalog.statement_timestamp() - interval '30 seconds'
        order by lease_expires_at, id
        limit $1::integer
      `, [input.limit]);
      let quarantined = 0;
      for (const candidate of candidates.rows) {
        const locked = await advisoryLock(
          client,
          accountLockKey(candidate.user_id, candidate.operation_id),
          false,
        );
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
          candidate.user_id,
          candidate.lease_expires_at,
        ]);
        if (result.rows[0]) quarantined += 1;
      }
      return quarantined;
    });
  }
}
