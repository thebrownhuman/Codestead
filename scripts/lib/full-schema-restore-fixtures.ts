import type {
  FullSchemaRestoreQueryClient,
} from "./full-schema-restore-database";

const QUARANTINED_ACCOUNT_ID =
  "20000000-0000-4000-8000-000000000002";
const QUARANTINED_SYSTEM_ID =
  "20000000-0000-4000-8000-000000000004";

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
       'dispatch_binding_sha256'
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

const VERIFY_FIXTURES_SQL = `
  select pg_catalog.count(*)::text as fixture_count
    from public.email_outbox outbox
   where outbox.idempotency_key like 'full-schema-restore:%'
`;

function exactReturnedRows(
  result: Readonly<{ rows: readonly Record<string, unknown>[] }>,
  count: number,
): void {
  if (result.rows.length !== count) {
    throw new Error("full-schema restore fixture transition failed");
  }
}

export async function seedRepresentativeMailAuthorityRows(input: Readonly<{
  owner: FullSchemaRestoreQueryClient;
  worker: FullSchemaRestoreQueryClient;
}>): Promise<void> {
  await input.owner.query(BASE_FIXTURES_SQL);
  const bindingColumns = await input.owner.query(BINDING_COLUMNS_SQL);
  const observed = bindingColumns.rows.map((row) => row.attname);
  if (
    observed.some((name) => typeof name !== "string")
    || (
      observed.length !== 0
      && (
        observed.length !== 2
        || observed[0] !== "dispatch_binding_sha256"
        || observed[1] !== "dispatch_binding_version"
      )
    )
  ) {
    throw new Error(
      "full-schema restore dispatch-binding catalog is invalid",
    );
  }

  if (observed.length === 2) {
    exactReturnedRows(await input.worker.query(CLAIM_FOR_BINDING_SQL), 2);
    exactReturnedRows(await input.worker.query(ARM_BINDING_SQL), 2);
    exactReturnedRows(
      await input.owner.query(RELEASE_BOUND_ROWS_SQL),
      2,
    );
  } else {
    exactReturnedRows(
      await input.owner.query(RELEASE_PRE_BINDING_ROWS_SQL),
      2,
    );
  }

  const verification = await input.owner.query(VERIFY_FIXTURES_SQL);
  if (verification.rows[0]?.fixture_count !== "4") {
    throw new Error("full-schema restore fixture verification failed");
  }
}
