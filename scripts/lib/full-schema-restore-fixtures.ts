import {
  stableSha256,
  type FullSchemaRestoreQueryClient,
} from "./full-schema-restore-database";

const QUARANTINED_ACCOUNT_ID = "20000000-0000-4000-8000-000000000002";
const QUARANTINED_SYSTEM_ID = "20000000-0000-4000-8000-000000000004";

const BASE_FIXTURES_SQL = `
  insert into public.user (
    id, name, email, email_verified, role, banned, status,
    public_id, must_change_password, created_at, updated_at
  ) values
    (
      'full-schema-restore-learner',
      'Restore learner',
      'learner.restore@invalid.local',
      true,
      'learner',
      false,
      'active',
      '10000000-0000-4000-8000-000000000010',
      false,
      pg_catalog.statement_timestamp() - interval '40 days',
      pg_catalog.statement_timestamp() - interval '40 days'
    ),
    (
      'full-schema-restore-admin',
      'Restore administrator',
      'admin.restore@invalid.local',
      true,
      'admin',
      false,
      'active',
      '10000000-0000-4000-8000-000000000011',
      false,
      pg_catalog.statement_timestamp() - interval '40 days',
      pg_catalog.statement_timestamp() - interval '40 days'
    );

  insert into public.access_request (
    id, email, name, reason, status, adult_confirmed_at,
    created_at, updated_at
  ) values (
    '10000000-0000-4000-8000-000000000001',
    'requester.restore@invalid.local',
    'Sensitive requester name',
    'restore verifier source authority',
    'pending',
    pg_catalog.statement_timestamp() - interval '40 days',
    pg_catalog.statement_timestamp() - interval '40 days',
    pg_catalog.statement_timestamp() - interval '40 days'
  );

  insert into public.email_outbox (
    id, operation_id, user_id, delivery_scope_key, to_email,
    template, template_version, variables, idempotency_key,
    status, next_attempt_at, created_at, updated_at
  ) values
    (
      '20000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      'full-schema-restore-learner',
      'a:full-schema-restore-learner',
      'learner.restore@invalid.local',
      'credential-changed',
      '1',
      pg_catalog.jsonb_build_object(
        'name', 'Sensitive learner name',
        'url', 'https://invalid.local/private-token'
      ),
      'full-schema-restore:account-pending:v1',
      'pending',
      pg_catalog.statement_timestamp(),
      pg_catalog.statement_timestamp(),
      pg_catalog.statement_timestamp()
    ),
    (
      '${QUARANTINED_ACCOUNT_ID}',
      '30000000-0000-4000-8000-000000000002',
      'full-schema-restore-learner',
      'a:full-schema-restore-learner',
      'learner.restore@invalid.local',
      'credential-changed',
      '1',
      pg_catalog.jsonb_build_object(
        'name', 'Sensitive learner name',
        'url', 'https://invalid.local/private-token'
      ),
      'full-schema-restore:account-quarantined:v1',
      'pending',
      pg_catalog.statement_timestamp() - interval '40 days',
      pg_catalog.statement_timestamp() - interval '40 days',
      pg_catalog.statement_timestamp() - interval '40 days'
    ),
    (
      '20000000-0000-4000-8000-000000000003',
      '30000000-0000-4000-8000-000000000003',
      null,
      's:30000000-0000-4000-8000-000000000003',
      'admin.restore@invalid.local',
      'access-request-admin',
      '1',
      pg_catalog.jsonb_build_object(
        '_mailOperationId', '30000000-0000-4000-8000-000000000003',
        '_mailRecipient', 'admin.restore@invalid.local',
        '_mailProducer', 'access-request-admin',
        '_mailSourceId', '10000000-0000-4000-8000-000000000001',
        'name', 'Sensitive requester name',
        'url', 'https://invalid.local/private-token'
      ),
      'full-schema-restore:system-pending:v1',
      'pending',
      pg_catalog.statement_timestamp(),
      pg_catalog.statement_timestamp(),
      pg_catalog.statement_timestamp()
    ),
    (
      '${QUARANTINED_SYSTEM_ID}',
      '30000000-0000-4000-8000-000000000004',
      null,
      's:30000000-0000-4000-8000-000000000004',
      'admin.restore@invalid.local',
      'access-request-admin',
      '1',
      pg_catalog.jsonb_build_object(
        '_mailOperationId', '30000000-0000-4000-8000-000000000004',
        '_mailRecipient', 'admin.restore@invalid.local',
        '_mailProducer', 'access-request-admin',
        '_mailSourceId', '10000000-0000-4000-8000-000000000001',
        'name', 'Sensitive requester name',
        'url', 'https://invalid.local/private-token'
      ),
      'full-schema-restore:system-quarantined:v1',
      'pending',
      pg_catalog.statement_timestamp() - interval '40 days',
      pg_catalog.statement_timestamp() - interval '40 days',
      pg_catalog.statement_timestamp() - interval '40 days'
    );
`;

const BINDING_COLUMNS_SQL = `
  select attribute.attname
    from pg_catalog.pg_attribute attribute
   where attribute.attrelid =
         'public.email_outbox'::pg_catalog.regclass
     and attribute.attnum > 0
     and not attribute.attisdropped
     and attribute.attname in (
       'dispatch_binding_version',
       'dispatch_binding_sha256',
       'provider_correlation_version',
       'provider_evidence_version',
       'provider_evidence_sha256'
     )
   order by attribute.attname
`;

const CLAIM_FOR_BINDING_SQL = `
  update public.email_outbox
     set status = 'sending',
         claim_token = case id
           when '${QUARANTINED_ACCOUNT_ID}'::uuid
             then '40000000-0000-4000-8000-000000000002'::uuid
           else '40000000-0000-4000-8000-000000000004'::uuid
         end,
         claim_owner = 'full-schema-restore-fixture',
         claim_version = claim_version + 1,
         lease_expires_at =
           pg_catalog.statement_timestamp() + interval '120 seconds',
         updated_at = pg_catalog.statement_timestamp()
   where id in (
     '${QUARANTINED_ACCOUNT_ID}'::uuid,
     '${QUARANTINED_SYSTEM_ID}'::uuid
   )
     and status = 'pending'
  returning id
`;

const ARM_BINDING_SQL = `
  update public.email_outbox
     set provider_call_started = pg_catalog.statement_timestamp(),
         adapter = 'gmail',
         dispatch_binding_version = 'gmail-raw-v1',
         dispatch_binding_sha256 = case id
           when '${QUARANTINED_ACCOUNT_ID}'::uuid
             then '${"a".repeat(64)}'
           else '${"b".repeat(64)}'
         end,
         lease_expires_at =
           pg_catalog.statement_timestamp() + interval '120 seconds',
         updated_at = pg_catalog.statement_timestamp()
   where id in (
     '${QUARANTINED_ACCOUNT_ID}'::uuid,
     '${QUARANTINED_SYSTEM_ID}'::uuid
   )
     and status = 'sending'
     and claim_token is not null
     and claim_owner = 'full-schema-restore-fixture'
     and lease_expires_at > pg_catalog.statement_timestamp()
     and provider_call_started is null
     and adapter is null
  returning id
`;

const ARM_CORRELATION_EVIDENCE_SQL = `
  update public.email_outbox
     set provider_call_started = pg_catalog.statement_timestamp(),
         adapter = 'gmail',
         dispatch_binding_version = 'gmail-raw-v1',
         dispatch_binding_sha256 = case id
           when '${QUARANTINED_ACCOUNT_ID}'::uuid
             then '${"a".repeat(64)}'
           else '${"b".repeat(64)}'
         end,
         provider_correlation_version = 'opaque-sha256-v1',
         provider_evidence_version = 'gmail-header-evidence-v1',
         provider_evidence_sha256 = case id
           when '${QUARANTINED_ACCOUNT_ID}'::uuid
             then '${"c".repeat(64)}'
           else '${"d".repeat(64)}'
         end,
         lease_expires_at =
           pg_catalog.statement_timestamp() + interval '120 seconds',
         updated_at = pg_catalog.statement_timestamp()
   where id in (
     '${QUARANTINED_ACCOUNT_ID}'::uuid,
     '${QUARANTINED_SYSTEM_ID}'::uuid
   )
     and status = 'sending'
     and claim_token is not null
     and claim_owner = 'full-schema-restore-fixture'
     and lease_expires_at > pg_catalog.statement_timestamp()
     and provider_call_started is null
     and adapter is null
     and provider_correlation_version is null
     and provider_evidence_version is null
     and provider_evidence_sha256 is null
  returning id
`;
const RELEASE_BOUND_ROWS_SQL = `
  update public.email_outbox
     set status = 'quarantined',
         claim_token = null,
         claim_owner = null,
         claim_version = claim_version + 1,
         lease_expires_at = null,
         quarantined_at =
           pg_catalog.statement_timestamp() - interval '40 days',
         last_error_code = 'FULL_SCHEMA_RESTORE_UNRESOLVED',
         updated_at =
           pg_catalog.statement_timestamp() - interval '40 days'
   where id in (
     '${QUARANTINED_ACCOUNT_ID}'::uuid,
     '${QUARANTINED_SYSTEM_ID}'::uuid
   )
     and status = 'sending'
     and provider_call_started is not null
     and adapter = 'gmail'
     and provider_message_id is null
     and sent_at is null
  returning id
`;

const RELEASE_PRE_BINDING_ROWS_SQL = `
  update public.email_outbox
     set status = 'quarantined',
         claim_token = null,
         claim_owner = null,
         claim_version = claim_version + 1,
         lease_expires_at = null,
         provider_call_started =
           pg_catalog.statement_timestamp() - interval '40 days',
         adapter = 'gmail',
         quarantined_at =
           pg_catalog.statement_timestamp() - interval '40 days',
         last_error_code = 'FULL_SCHEMA_RESTORE_UNRESOLVED',
         updated_at =
           pg_catalog.statement_timestamp() - interval '40 days'
   where id in (
     '${QUARANTINED_ACCOUNT_ID}'::uuid,
     '${QUARANTINED_SYSTEM_ID}'::uuid
   )
     and status = 'pending'
  returning id
`;

const BACKUP_AUTHORITY_CATALOG_SQL = `
  select
    pg_catalog.to_regclass(
      'public.backup_status_mail_authority'
    ) is not null as authority_table_present,
    pg_catalog.to_regprocedure(
      'public.enqueue_backup_status_mail_authority(text,text)'
    ) is not null as enqueue_routine_present,
    pg_catalog.to_regprocedure(
      'public.backup_status_mail_authorized(uuid)'
    ) is not null as authorize_routine_present
`;

const ENQUEUE_BACKUP_AUTHORITY_SQL = `
  select acknowledgement,
         authority_id::text as authority_id,
         outbox_id::text as outbox_id,
         operation_id::text as operation_id
    from public.enqueue_backup_status_mail_authority($1, $2)
`;

const VERIFY_BACKUP_AUTHORITY_SQL = `
  select authority.id::text as id,
         authority.run_key,
         authority.outcome,
         authority.recipient_user_id,
         authority.recipient_email,
         authority.outbox_id::text as outbox_id,
         authority.operation_id::text as operation_id,
         outbox.user_id,
         outbox.delivery_scope_key,
         outbox.to_email,
         outbox.template,
         outbox.template_version,
         outbox.variables,
         outbox.idempotency_key
    from public.backup_status_mail_authority authority
    join public.email_outbox outbox
      on outbox.id = authority.outbox_id
   where authority.run_key = $1
     and authority.outbox_id = $2::uuid
`;

const VERIFY_BACKUP_AUTHORIZED_SQL = `
  select public.backup_status_mail_authorized($1::uuid) as authorized
`;

const RESTORED_BACKUP_AUTHORITY_SQL = `
  select authority.id::text as authority_id,
         authority.outbox_id::text as outbox_id,
         authority.operation_id::text as operation_id
    from public.backup_status_mail_authority authority
   where authority.run_key = $1
   order by authority.run_key, authority.id
`;

const VERIFY_FIXTURES_SQL = `
  select pg_catalog.count(*)::text as fixture_count
    from public.email_outbox outbox
   where outbox.idempotency_key like 'full-schema-restore:%'
      or outbox.idempotency_key =
         'backup-status:v1:20260725T000000Z'
`;

function exactReturnedRows(
  result: Readonly<{ rows: readonly Record<string, unknown>[] }>,
  count: number,
): void {
  if (result.rows.length !== count) {
    throw new Error("full-schema restore fixture transition failed");
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BACKUP_RUN_KEY = "20260725T000000Z";
const BACKUP_SUMMARY =
  "The nightly encrypted backup completed and passed local verification. " +
  "No archive is attached to this email.";

function verifiedBackupAuthority(
  row: Record<string, unknown> | undefined,
  queued: Readonly<{
    authorityId: string;
    outboxId: string;
    operationId: string;
  }>,
): boolean {
  const expectedVariables = {
    name: "Administrator",
    summary: BACKUP_SUMMARY,
  };
  try {
    return (
      row?.id === queued.authorityId &&
      row.run_key === BACKUP_RUN_KEY &&
      row.outcome === "success" &&
      row.recipient_user_id === "full-schema-restore-admin" &&
      row.recipient_email === "admin.restore@invalid.local" &&
      row.outbox_id === queued.outboxId &&
      row.operation_id === queued.operationId &&
      row.user_id === "full-schema-restore-admin" &&
      row.delivery_scope_key === "a:full-schema-restore-admin" &&
      row.to_email === "admin.restore@invalid.local" &&
      row.template === "backup-status" &&
      row.template_version === "1" &&
      row.idempotency_key === `backup-status:v1:${BACKUP_RUN_KEY}` &&
      row.variables !== null &&
      typeof row.variables === "object" &&
      !Array.isArray(row.variables) &&
      stableSha256(row.variables) === stableSha256(expectedVariables)
    );
  } catch {
    return false;
  }
}

async function seedBackupAuthorityWhenPresent(
  input: Readonly<{
    owner: FullSchemaRestoreQueryClient;
    worker: FullSchemaRestoreQueryClient;
    backupReporter: FullSchemaRestoreQueryClient;
  }>,
): Promise<boolean> {
  const catalog = (await input.owner.query(BACKUP_AUTHORITY_CATALOG_SQL))
    .rows[0];
  const tablePresent = catalog?.authority_table_present === true;
  const enqueuePresent = catalog?.enqueue_routine_present === true;
  const authorizePresent = catalog?.authorize_routine_present === true;
  if (!tablePresent && !enqueuePresent && !authorizePresent) return false;
  if (!tablePresent || !enqueuePresent || !authorizePresent) {
    throw new Error("full-schema restore backup authority catalog is invalid");
  }

  const enqueued = await input.backupReporter.query(
    ENQUEUE_BACKUP_AUTHORITY_SQL,
    [BACKUP_RUN_KEY, "success"],
  );
  const row = enqueued.rows[0];
  const authorityId = row?.authority_id;
  const outboxId = row?.outbox_id;
  const operationId = row?.operation_id;
  if (
    enqueued.rows.length !== 1 ||
    row?.acknowledgement !== "queued" ||
    typeof authorityId !== "string" ||
    !UUID_PATTERN.test(authorityId) ||
    typeof outboxId !== "string" ||
    !UUID_PATTERN.test(outboxId) ||
    typeof operationId !== "string" ||
    !UUID_PATTERN.test(operationId)
  ) {
    throw new Error("full-schema restore backup authority enqueue failed");
  }

  const verification = await input.owner.query(VERIFY_BACKUP_AUTHORITY_SQL, [
    BACKUP_RUN_KEY,
    outboxId,
  ]);
  const authorization = await input.worker.query(VERIFY_BACKUP_AUTHORIZED_SQL, [
    outboxId,
  ]);
  if (
    verification.rows.length !== 1 ||
    !verifiedBackupAuthority(verification.rows[0], {
      authorityId,
      outboxId,
      operationId,
    }) ||
    authorization.rows.length !== 1 ||
    authorization.rows[0]?.authorized !== true
  ) {
    throw new Error("full-schema restore backup authority verification failed");
  }
  return true;
}

export async function seedRepresentativeMailAuthorityRows(
  input: Readonly<{
    owner: FullSchemaRestoreQueryClient;
    worker: FullSchemaRestoreQueryClient;
    backupReporter: FullSchemaRestoreQueryClient;
  }>,
): Promise<void> {
  await input.owner.query(BASE_FIXTURES_SQL);
  const bindingColumns = await input.owner.query(BINDING_COLUMNS_SQL);
  const observed = bindingColumns.rows.map((row) => row.attname);
  if (
    observed.some((name) => typeof name !== "string") ||
    !(
      observed.length === 0 ||
      (observed.length === 2 &&
        observed[0] === "dispatch_binding_sha256" &&
        observed[1] === "dispatch_binding_version") ||
      (observed.length === 5 &&
        observed[0] === "dispatch_binding_sha256" &&
        observed[1] === "dispatch_binding_version" &&
        observed[2] === "provider_correlation_version" &&
        observed[3] === "provider_evidence_sha256" &&
        observed[4] === "provider_evidence_version")
    )
  ) {
    throw new Error("full-schema restore dispatch-binding catalog is invalid");
  }

  if (observed.length >= 2) {
    exactReturnedRows(await input.worker.query(CLAIM_FOR_BINDING_SQL), 2);
    exactReturnedRows(
      await input.worker.query(
        observed.length === 5 ? ARM_CORRELATION_EVIDENCE_SQL : ARM_BINDING_SQL,
      ),
      2,
    );
    exactReturnedRows(await input.owner.query(RELEASE_BOUND_ROWS_SQL), 2);
  } else {
    exactReturnedRows(await input.owner.query(RELEASE_PRE_BINDING_ROWS_SQL), 2);
  }

  const backupAuthorityPresent = await seedBackupAuthorityWhenPresent(input);
  const verification = await input.owner.query(VERIFY_FIXTURES_SQL);
  const expectedCount = backupAuthorityPresent ? "5" : "4";
  if (verification.rows[0]?.fixture_count !== expectedCount) {
    throw new Error("full-schema restore fixture verification failed");
  }
}

export async function verifyRestoredBackupAuthorityRows(
  input: Readonly<{
    owner: FullSchemaRestoreQueryClient;
    worker: FullSchemaRestoreQueryClient;
    backupReporter: FullSchemaRestoreQueryClient;
  }>,
): Promise<void> {
  const catalog = (await input.owner.query(BACKUP_AUTHORITY_CATALOG_SQL))
    .rows[0];
  const tablePresent = catalog?.authority_table_present === true;
  const enqueuePresent = catalog?.enqueue_routine_present === true;
  const authorizePresent = catalog?.authorize_routine_present === true;
  if (!tablePresent && !enqueuePresent && !authorizePresent) return;
  if (!tablePresent || !enqueuePresent || !authorizePresent) {
    throw new Error("full-schema restore backup authority catalog is invalid");
  }

  const restored = await input.owner.query(RESTORED_BACKUP_AUTHORITY_SQL, [
    BACKUP_RUN_KEY,
  ]);
  const restoredRow = restored.rows[0];
  const authorityId = restoredRow?.authority_id;
  const outboxId = restoredRow?.outbox_id;
  const operationId = restoredRow?.operation_id;
  if (
    restored.rows.length !== 1 ||
    typeof authorityId !== "string" ||
    !UUID_PATTERN.test(authorityId) ||
    typeof outboxId !== "string" ||
    !UUID_PATTERN.test(outboxId) ||
    typeof operationId !== "string" ||
    !UUID_PATTERN.test(operationId)
  ) {
    throw new Error("full-schema restore backup authority replay failed");
  }

  const replayed = await input.backupReporter.query(
    ENQUEUE_BACKUP_AUTHORITY_SQL,
    [BACKUP_RUN_KEY, "success"],
  );
  const replay = replayed.rows[0];
  if (
    replayed.rows.length !== 1 ||
    replay?.acknowledgement !== "existing" ||
    replay.authority_id !== authorityId ||
    replay.outbox_id !== outboxId ||
    replay.operation_id !== operationId
  ) {
    throw new Error("full-schema restore backup authority replay failed");
  }

  const verification = await input.owner.query(VERIFY_BACKUP_AUTHORITY_SQL, [
    BACKUP_RUN_KEY,
    outboxId,
  ]);
  const authorization = await input.worker.query(VERIFY_BACKUP_AUTHORIZED_SQL, [
    outboxId,
  ]);
  if (
    verification.rows.length !== 1 ||
    !verifiedBackupAuthority(verification.rows[0], {
      authorityId,
      outboxId,
      operationId,
    }) ||
    authorization.rows.length !== 1 ||
    authorization.rows[0]?.authorized !== true
  ) {
    throw new Error("full-schema restore backup authority verification failed");
  }
}
