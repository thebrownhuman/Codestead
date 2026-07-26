-- Forward-only Task 6 component. Journal, snapshot, reviewed-ledger, role
-- bootstrap, and CI registration are intentionally integration-owned.
LOCK TABLE ONLY public.email_outbox IN ACCESS EXCLUSIVE MODE NOWAIT;--> statement-breakpoint
SET LOCAL search_path = pg_catalog, pg_temp;--> statement-breakpoint

DO $preflight$
DECLARE
  coverage_acl pg_catalog.text[];
  expected_hold_columns CONSTANT pg_catalog.text[] := ARRAY[
    'adapter', 'attempt_count', 'claim_owner', 'claim_token', 'claim_version',
    'delivery_hold_version', 'dispatch_binding_sha256',
    'dispatch_binding_version', 'idempotency_authority_sha256',
    'idempotency_authority_version',
    'idempotency_original_payload_sha256', 'last_error_code',
    'lease_expires_at', 'next_attempt_at', 'provider_call_started',
    'provider_correlation_version', 'provider_evidence_sha256',
    'provider_evidence_version', 'provider_message_id', 'quarantined_at',
    'sent_at', 'status'
  ]::pg_catalog.text[];
BEGIN
  IF pg_catalog.to_regprocedure(
       'public.email_outbox_idempotency_coverage_authority(uuid[])'
     ) IS NULL
     OR pg_catalog.to_regclass(
       'public.email_outbox_idempotency_authority'
     ) IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.email_outbox'::pg_catalog.regclass
          AND attribute.attname = 'idempotency_original_payload_sha256'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND attribute.attnotnull
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.email_outbox'::pg_catalog.regclass
          AND attribute.attname = 'delivery_hold_version'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND attribute.attnotnull
     )
     OR EXISTS (
       SELECT 1
         FROM public.email_outbox AS outbox
        WHERE outbox.delivery_hold_version IS DISTINCT FROM 'task7-v1'
     )
  THEN
    RAISE EXCEPTION
      'email outbox durable replay predecessor is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS relation
     WHERE relation.oid = 'public.email_outbox'::pg_catalog.regclass
       AND relation.relkind = 'r'
       AND pg_catalog.pg_get_userbyid(relation.relowner) =
             'learncoding_owner'
  ) THEN
    RAISE EXCEPTION 'email_outbox predecessor owner is invalid'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS relation
     WHERE relation.oid =
             'public.email_outbox_idempotency_authority'::pg_catalog.regclass
       AND relation.relkind = 'r'
       AND relation.relpersistence = 'p'
       AND pg_catalog.pg_get_userbyid(relation.relowner) =
             'learncoding_owner'
  ) THEN
    RAISE EXCEPTION 'idempotency authority predecessor is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = constraint_row.conrelid
     WHERE constraint_row.conrelid =
             'public.email_outbox'::pg_catalog.regclass
       AND constraint_row.conname = 'email_outbox_delivery_scope_valid'
       AND constraint_row.contype = 'c'
       AND constraint_row.convalidated
       AND NOT constraint_row.connoinherit
       AND (
         SELECT pg_catalog.array_agg(
                  attribute.attname::pg_catalog.text
                  ORDER BY attribute.attname::pg_catalog.text
                )
           FROM pg_catalog.unnest(
                  constraint_row.conkey
                ) AS constrained(attnum)
           JOIN pg_catalog.pg_attribute AS attribute
             ON attribute.attrelid = constraint_row.conrelid
            AND attribute.attnum = constrained.attnum
       ) IS NOT DISTINCT FROM ARRAY[
         'delivery_scope_key',
         'operation_id',
         'status',
         'template',
         'template_version',
         'to_email',
         'user_id',
         'variables'
       ]::pg_catalog.text[]
       AND pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(
                 pg_catalog.regexp_replace(
                   pg_catalog.regexp_replace(
                     pg_catalog.pg_get_expr(
                       constraint_row.conbin,
                       constraint_row.conrelid,
                       true
                     ),
                     '"?' || relation.relname || '"?[.]',
                     '',
                     'g'
                   ),
                   '[[:space:]"]',
                   '',
                   'g'
                 ),
                 'UTF8'
               )
             ),
             'hex'
           ) =
             'c904768e4ecc145fc108de90adf0d0b5373f3330fb706ec34ff4b07d2711b94f'
  ) THEN
    RAISE EXCEPTION 'delivery-scope predecessor constraint is invalid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_delivery_scope_valid';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = constraint_row.conrelid
       AND attribute.attname = 'delivery_hold_version'
     WHERE constraint_row.conrelid =
             'public.email_outbox'::pg_catalog.regclass
       AND constraint_row.conname = 'email_outbox_delivery_hold_valid'
       AND constraint_row.contype = 'c'
       AND constraint_row.convalidated
       AND NOT constraint_row.connoinherit
       AND constraint_row.conkey =
             ARRAY[attribute.attnum]::pg_catalog.int2[]
       AND pg_catalog.lower(
             pg_catalog.regexp_replace(
               pg_catalog.replace(
                 pg_catalog.pg_get_expr(
                   constraint_row.conbin,
                   constraint_row.conrelid,
                   false
                 ),
                 '::text',
                 ''
               ),
               '[[:space:]()]',
               '',
               'g'
             )
           ) = 'delivery_hold_version=''task7-v1''istrue'
  ) THEN
    RAISE EXCEPTION 'delivery-hold predecessor constraint is invalid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_delivery_hold_valid';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_constraint AS digest_constraint
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = digest_constraint.conrelid
       AND digest_constraint.conkey =
             ARRAY[attribute.attnum]::pg_catalog.int2[]
     WHERE digest_constraint.conrelid =
             'public.email_outbox_idempotency_authority'
               ::pg_catalog.regclass
       AND digest_constraint.contype = 'c'
       AND digest_constraint.convalidated
       AND NOT digest_constraint.connoinherit
       AND (
         digest_constraint.conname,
         attribute.attname::pg_catalog.text,
         pg_catalog.lower(
           pg_catalog.regexp_replace(
             pg_catalog.replace(
               pg_catalog.pg_get_expr(
                 digest_constraint.conbin,
                 digest_constraint.conrelid,
                 false
               ),
               '::text', ''
             ),
             '[[:space:]()]', '', 'g'
           )
         )
       ) IN (
         ('email_outbox_idempotency_authority_digest_valid',
          'idempotency_sha256',
          'idempotency_sha256~''^[0-9a-f]{64}$'''),
         ('email_outbox_idempotency_authority_payload_valid',
          'original_payload_sha256',
          'original_payload_sha256~''^[0-9a-f]{64}$''')
       )
  ) <> 2 THEN
    RAISE EXCEPTION 'idempotency digest predecessor is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS foreign_key
      JOIN pg_catalog.pg_constraint AS referenced_unique
        ON referenced_unique.conrelid = foreign_key.confrelid
       AND referenced_unique.conname =
             'email_outbox_idempotency_authority_payload_unique'
       AND referenced_unique.contype = 'u'
       AND referenced_unique.convalidated
       AND referenced_unique.conindid = foreign_key.conindid
     WHERE foreign_key.conrelid =
             'public.email_outbox'::pg_catalog.regclass
       AND foreign_key.confrelid =
             'public.email_outbox_idempotency_authority'::pg_catalog.regclass
       AND foreign_key.conname = 'email_outbox_idempotency_authority_fk'
       AND foreign_key.contype = 'f'
       AND foreign_key.convalidated
       AND foreign_key.condeferrable
       AND foreign_key.condeferred
       AND foreign_key.confupdtype = 'r'
       AND foreign_key.confdeltype = 'r'
       AND foreign_key.confmatchtype = 's'
       AND foreign_key.conkey = ARRAY[
         (SELECT attribute.attnum
            FROM pg_catalog.pg_attribute AS attribute
           WHERE attribute.attrelid = foreign_key.conrelid
             AND attribute.attname = 'idempotency_authority_sha256'),
         (SELECT attribute.attnum
            FROM pg_catalog.pg_attribute AS attribute
           WHERE attribute.attrelid = foreign_key.conrelid
             AND attribute.attname = 'idempotency_original_payload_sha256')
       ]::pg_catalog.int2[]
       AND foreign_key.confkey = ARRAY[
         (SELECT attribute.attnum
            FROM pg_catalog.pg_attribute AS attribute
           WHERE attribute.attrelid = foreign_key.confrelid
             AND attribute.attname = 'idempotency_sha256'),
         (SELECT attribute.attnum
            FROM pg_catalog.pg_attribute AS attribute
           WHERE attribute.attrelid = foreign_key.confrelid
             AND attribute.attname = 'original_payload_sha256')
       ]::pg_catalog.int2[]
  ) THEN
    RAISE EXCEPTION 'idempotency authority predecessor FK is invalid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_idempotency_authority_fk';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS routine
      JOIN pg_catalog.pg_language AS language
        ON language.oid = routine.prolang
     WHERE routine.oid = pg_catalog.to_regprocedure(
             'public.enforce_email_outbox_delivery_hold()'
           )
       AND pg_catalog.pg_get_userbyid(routine.proowner) =
             'learncoding_owner'
       AND routine.prosecdef
       AND routine.provolatile = 'v'
       AND routine.prokind = 'f'
       AND routine.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
       AND routine.proconfig =
             ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
       AND language.lanname = 'plpgsql'
       AND pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(routine.prosrc, 'UTF8')
             ),
             'hex'
           ) =
             'bf644f8a69cea40011d7268ac8f14d8775045fe923cb2ca5f06a9cd25a39c8e8'
       AND pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(
                 pg_catalog.pg_get_functiondef(routine.oid),
                 'UTF8'
               )
             ),
             'hex'
           ) =
             '9af2d218cd9a189c84db693acefefa10826d796058505cce85124d6830d6fe53'
  ) THEN
    RAISE EXCEPTION 'delivery-hold predecessor function is invalid'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
     WHERE trigger_row.tgrelid =
             'public.email_outbox'::pg_catalog.regclass
       AND trigger_row.tgname = 'email_outbox_delivery_hold'
       AND NOT trigger_row.tgisinternal
       AND trigger_row.tgconstraint = 0
       AND trigger_row.tgconstrrelid = 0
       AND trigger_row.tgqual IS NULL
       AND trigger_row.tgtype = 19
       AND trigger_row.tgenabled = 'A'
       AND trigger_row.tgfoid = pg_catalog.to_regprocedure(
             'public.enforce_email_outbox_delivery_hold()'
           )
       AND (
         SELECT pg_catalog.array_agg(
                  attribute.attname::pg_catalog.text
                  ORDER BY attribute.attname::pg_catalog.text
                )
           FROM pg_catalog.unnest(
                  trigger_row.tgattr::pg_catalog.int2[]
                ) AS trigger_attribute(attnum)
           JOIN pg_catalog.pg_attribute AS attribute
             ON attribute.attrelid = trigger_row.tgrelid
            AND attribute.attnum = trigger_attribute.attnum
       ) IS NOT DISTINCT FROM expected_hold_columns
  ) THEN
    RAISE EXCEPTION 'delivery-hold predecessor trigger is invalid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_delivery_hold_valid';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS routine
      JOIN pg_catalog.pg_language AS language
        ON language.oid = routine.prolang
     WHERE routine.oid = pg_catalog.to_regprocedure(
             'public.email_outbox_idempotency_coverage_authority(pg_catalog.uuid[])'
           )
       AND pg_catalog.pg_get_userbyid(routine.proowner) =
             'learncoding_owner'
       AND routine.prosecdef
       AND routine.provolatile = 'v'
       AND routine.prokind = 'f'
       AND routine.prorettype = 'pg_catalog.bool'::pg_catalog.regtype
       AND NOT routine.proretset
       AND routine.proconfig =
             ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
       AND language.lanname = 'plpgsql'
       AND pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(routine.prosrc, 'UTF8')
             ),
             'hex'
           ) =
             '417c8583bb2509354b89e63317718a14cd0afbf08e62d534cd64341acc290e48'
       AND pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(
                 pg_catalog.pg_get_functiondef(routine.oid),
                 'UTF8'
               )
             ),
             'hex'
           ) =
             '2efbc33e8ee9dd33402f11682697f4e522cd9e7e3c70c8bf820f533b37aec1ac'
  ) THEN
    RAISE EXCEPTION 'idempotency coverage predecessor function is invalid'
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(
           pg_catalog.array_agg(
             pg_catalog.format(
               '%s|%s|%s|%s',
               CASE WHEN access.grantee = 0
                 THEN 'PUBLIC'
                 ELSE pg_catalog.pg_get_userbyid(access.grantee)
               END,
               CASE WHEN access.grantor = 0
                 THEN 'PUBLIC'
                 ELSE pg_catalog.pg_get_userbyid(access.grantor)
               END,
               pg_catalog.lower(access.privilege_type),
               access.is_grantable::pg_catalog.text
             )
             ORDER BY
               CASE WHEN access.grantee = 0
                 THEN 'PUBLIC'
                 ELSE pg_catalog.pg_get_userbyid(access.grantee)
               END,
               CASE WHEN access.grantor = 0
                 THEN 'PUBLIC'
                 ELSE pg_catalog.pg_get_userbyid(access.grantor)
               END,
               pg_catalog.lower(access.privilege_type),
               access.is_grantable
           ),
           ARRAY[]::pg_catalog.text[]
         )
    INTO coverage_acl
    FROM pg_catalog.pg_proc AS routine
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        routine.proacl,
        pg_catalog.acldefault('f', routine.proowner)
      )
    ) AS access
   WHERE routine.oid = pg_catalog.to_regprocedure(
           'public.email_outbox_idempotency_coverage_authority(pg_catalog.uuid[])'
         );

  IF coverage_acl IS DISTINCT FROM ARRAY[
       'learncoding_ops|learncoding_owner|execute|false',
       'learncoding_owner|learncoding_owner|execute|false'
     ]::pg_catalog.text[]
  THEN
    RAISE EXCEPTION 'idempotency coverage predecessor ACL is invalid'
      USING ERRCODE = '42501';
  END IF;
END
$preflight$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION
  "public"."classify_email_outbox_quarantine_redaction_v2"(
    "candidate" "public"."email_outbox",
    "cutoff_at" timestamp with time zone
  )
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  expected_email text;
  expected_variables jsonb;
  raw_disposition text;
  claim_authority_parts integer;
BEGIN
  IF candidate.id IS NULL
     OR cutoff_at IS NULL
     OR candidate.status IS DISTINCT FROM
          'quarantined'::public.notification_status
     OR NOT (
       COALESCE(
         candidate.quarantined_at,
         candidate.updated_at,
         candidate.created_at
       ) < cutoff_at
     )
  THEN
    RETURN NULL;
  END IF;

  expected_email :=
    'redacted+' || candidate.id::text || '@invalid.local';

  IF candidate.user_id IS NOT NULL
     AND candidate.delivery_scope_key IS NOT DISTINCT FROM
           'a:' || candidate.user_id
  THEN
    raw_disposition := 'eligible_account';
    expected_variables := '{}'::jsonb;
  ELSIF candidate.user_id IS NULL
        AND candidate.delivery_scope_key IS NOT DISTINCT FROM
              's:' || candidate.operation_id::text
        AND candidate.template_version IS NOT DISTINCT FROM '1'
        AND candidate.variables ->> '_mailOperationId'
              IS NOT DISTINCT FROM candidate.operation_id::text
        AND candidate.variables ->> '_mailRecipient'
              IS NOT DISTINCT FROM candidate.to_email
        AND COALESCE(
              candidate.variables ->> '_mailSourceId'
                ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
              false
            )
        AND (
          (
            candidate.template = 'access-request-admin'
            AND candidate.variables ->> '_mailProducer'
                  IS NOT DISTINCT FROM 'access-request-admin'
          )
          OR (
            candidate.template = 'invitation'
            AND candidate.variables ->> '_mailProducer'
                  IS NOT DISTINCT FROM 'access-request-approved'
          )
          OR (
            candidate.template = 'access-rejected'
            AND candidate.variables ->> '_mailProducer'
                  IS NOT DISTINCT FROM 'access-request-rejected'
          )
        )
  THEN
    raw_disposition := 'eligible_system';
    expected_variables := pg_catalog.jsonb_build_object(
      '_mailOperationId', candidate.operation_id::text,
      '_mailRecipient', expected_email,
      '_mailProducer', candidate.variables ->> '_mailProducer',
      '_mailSourceId', candidate.variables ->> '_mailSourceId'
    ) || CASE
      WHEN candidate.variables ? '_mailAudienceId'
        THEN pg_catalog.jsonb_build_object(
          '_mailAudienceId', candidate.variables -> '_mailAudienceId'
        )
      ELSE '{}'::jsonb
    END;
  ELSIF candidate.user_id IS NULL
        AND candidate.delivery_scope_key IS NOT DISTINCT FROM
              'o:' || candidate.operation_id::text
  THEN
    raw_disposition := 'eligible_operation';
    expected_variables := '{}'::jsonb;
  ELSE
    raw_disposition := 'malformed';
    expected_variables := '{}'::jsonb;
  END IF;

  IF candidate.to_email IS NOT DISTINCT FROM expected_email
     AND candidate.variables IS NOT DISTINCT FROM expected_variables
  THEN
    RETURN NULL;
  END IF;

  claim_authority_parts := pg_catalog.num_nonnulls(
    candidate.claim_token,
    candidate.claim_owner,
    candidate.lease_expires_at
  );
  IF claim_authority_parts = 0 THEN
    RETURN raw_disposition;
  END IF;
  IF claim_authority_parts BETWEEN 1 AND 2 THEN
    IF raw_disposition = 'malformed' THEN
      RETURN raw_disposition;
    END IF;
    -- A partial claim is malformed but cannot carry complete send authority.
    RETURN 'eligible_malformed';
  END IF;
  IF claim_authority_parts = 3
     AND candidate.lease_expires_at >
           pg_catalog.statement_timestamp()
  THEN
    RETURN 'blocked';
  END IF;

  RETURN raw_disposition;
END
$function$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION
  "public"."enforce_email_outbox_payload_immutable"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  redaction_disposition text;
  expected_email text;
  expected_variables jsonb;
BEGIN
  IF current_user = 'learncoding_owner'
     AND session_user = 'learncoding_ops'
  THEN
    redaction_disposition :=
      "public"."classify_email_outbox_quarantine_redaction_v2"(
        OLD,
        pg_catalog.statement_timestamp() - interval '30 days'
      );
    expected_email := 'redacted+' || OLD.id::text || '@invalid.local';
    expected_variables :=
      CASE WHEN redaction_disposition = 'eligible_system'
        THEN pg_catalog.jsonb_build_object(
          '_mailOperationId', OLD.operation_id::text,
          '_mailRecipient', expected_email,
          '_mailProducer', OLD.variables ->> '_mailProducer',
          '_mailSourceId', OLD.variables ->> '_mailSourceId'
        ) || CASE
          WHEN OLD.variables ? '_mailAudienceId'
            THEN pg_catalog.jsonb_build_object(
              '_mailAudienceId', OLD.variables -> '_mailAudienceId'
            )
          ELSE '{}'::jsonb
        END
        ELSE '{}'::jsonb
      END;

    IF redaction_disposition IN (
         'eligible_account',
         'eligible_system',
         'eligible_operation',
         'eligible_malformed',
         'malformed'
       )
       AND NEW.to_email = expected_email
       AND NEW.variables = expected_variables
       AND (
         OLD.to_email IS DISTINCT FROM NEW.to_email
         OR OLD.variables IS DISTINCT FROM NEW.variables
       )
       AND NEW.updated_at = pg_catalog.statement_timestamp()
       AND OLD.id IS NOT DISTINCT FROM NEW.id
       AND OLD.user_id IS NOT DISTINCT FROM NEW.user_id
       AND OLD.template IS NOT DISTINCT FROM NEW.template
       AND OLD.template_version IS NOT DISTINCT FROM NEW.template_version
       AND OLD.idempotency_key IS NOT DISTINCT FROM NEW.idempotency_key
       AND OLD.idempotency_authority_version
             IS NOT DISTINCT FROM NEW.idempotency_authority_version
       AND OLD.idempotency_authority_sha256
             IS NOT DISTINCT FROM NEW.idempotency_authority_sha256
       AND OLD.idempotency_original_payload_sha256
             IS NOT DISTINCT FROM NEW.idempotency_original_payload_sha256
       AND OLD.delivery_hold_version
             IS NOT DISTINCT FROM NEW.delivery_hold_version
       AND OLD.operation_id IS NOT DISTINCT FROM NEW.operation_id
       AND OLD.delivery_scope_key IS NOT DISTINCT FROM NEW.delivery_scope_key
       AND OLD.status IS NOT DISTINCT FROM NEW.status
       AND OLD.attempt_count IS NOT DISTINCT FROM NEW.attempt_count
       AND OLD.claim_token IS NOT DISTINCT FROM NEW.claim_token
       AND OLD.claim_owner IS NOT DISTINCT FROM NEW.claim_owner
       AND OLD.claim_version IS NOT DISTINCT FROM NEW.claim_version
       AND OLD.lease_expires_at IS NOT DISTINCT FROM NEW.lease_expires_at
       AND OLD.provider_call_started
             IS NOT DISTINCT FROM NEW.provider_call_started
       AND OLD.adapter IS NOT DISTINCT FROM NEW.adapter
       AND OLD.dispatch_binding_version
             IS NOT DISTINCT FROM NEW.dispatch_binding_version
       AND OLD.dispatch_binding_sha256
             IS NOT DISTINCT FROM NEW.dispatch_binding_sha256
       AND OLD.provider_correlation_version
             IS NOT DISTINCT FROM NEW.provider_correlation_version
       AND OLD.provider_evidence_version
             IS NOT DISTINCT FROM NEW.provider_evidence_version
       AND OLD.provider_evidence_sha256
             IS NOT DISTINCT FROM NEW.provider_evidence_sha256
       AND OLD.provider_message_id
             IS NOT DISTINCT FROM NEW.provider_message_id
       AND OLD.next_attempt_at IS NOT DISTINCT FROM NEW.next_attempt_at
       AND OLD.sent_at IS NOT DISTINCT FROM NEW.sent_at
       AND OLD.quarantined_at IS NOT DISTINCT FROM NEW.quarantined_at
       AND OLD.last_error_code IS NOT DISTINCT FROM NEW.last_error_code
       AND OLD.created_at IS NOT DISTINCT FROM NEW.created_at
    THEN
      RETURN NEW;
    END IF;
  END IF;

  IF OLD.user_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'email_outbox.user_id is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.to_email IS DISTINCT FROM NEW.to_email THEN
    RAISE EXCEPTION 'email_outbox.to_email is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.template IS DISTINCT FROM NEW.template THEN
    RAISE EXCEPTION 'email_outbox.template is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.template_version IS DISTINCT FROM NEW.template_version THEN
    RAISE EXCEPTION 'email_outbox.template_version is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.variables IS DISTINCT FROM NEW.variables THEN
    RAISE EXCEPTION 'email_outbox.variables is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key THEN
    RAISE EXCEPTION 'email_outbox.idempotency_key is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.idempotency_authority_version IS DISTINCT FROM
       NEW.idempotency_authority_version THEN
    RAISE EXCEPTION 'email_outbox.idempotency_authority_version is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.idempotency_authority_sha256 IS DISTINCT FROM
       NEW.idempotency_authority_sha256 THEN
    RAISE EXCEPTION 'email_outbox.idempotency_authority_sha256 is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.idempotency_original_payload_sha256 IS DISTINCT FROM
       NEW.idempotency_original_payload_sha256 THEN
    RAISE EXCEPTION
      'email_outbox.idempotency_original_payload_sha256 is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.delivery_hold_version IS DISTINCT FROM
       NEW.delivery_hold_version THEN
    RAISE EXCEPTION 'email_outbox.delivery_hold_version is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.operation_id IS DISTINCT FROM NEW.operation_id THEN
    RAISE EXCEPTION 'email_outbox.operation_id is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.delivery_scope_key IS DISTINCT FROM NEW.delivery_scope_key THEN
    RAISE EXCEPTION 'email_outbox.delivery_scope_key is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;--> statement-breakpoint

DROP TRIGGER IF EXISTS "email_outbox_payload_immutable"
  ON public.email_outbox;--> statement-breakpoint
CREATE TRIGGER "email_outbox_payload_immutable"
BEFORE UPDATE OF
  "user_id",
  "to_email",
  "template",
  "template_version",
  "variables",
  "idempotency_key",
  "idempotency_authority_version",
  "idempotency_authority_sha256",
  "idempotency_original_payload_sha256",
  "delivery_hold_version",
  "operation_id",
  "delivery_scope_key"
ON public.email_outbox
FOR EACH ROW
EXECUTE FUNCTION
  "public"."enforce_email_outbox_payload_immutable"();--> statement-breakpoint
ALTER TABLE public.email_outbox
  ENABLE ALWAYS TRIGGER "email_outbox_payload_immutable";--> statement-breakpoint

CREATE OR REPLACE FUNCTION
  "public"."redact_quarantined_email_outbox_authority_v2"(
    "cutoff_at" timestamp with time zone,
    "batch_limit" integer
  )
RETURNS TABLE(
  "disposition" text,
  "eligible" bigint,
  "transitioned" bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  report_only boolean := batch_limit = 0;
BEGIN
  IF session_user <> 'learncoding_ops'
     OR current_user <> 'learncoding_owner'
  THEN
    RAISE EXCEPTION 'email outbox redaction caller is not authorized'
      USING ERRCODE = '42501';
  END IF;
  IF cutoff_at IS NULL
     OR cutoff_at >
          pg_catalog.statement_timestamp() - interval '30 days'
  THEN
    RAISE EXCEPTION
      'email outbox redaction cutoff violates retention policy'
      USING ERRCODE = '22023';
  END IF;
  IF batch_limit IS NULL OR batch_limit < 0 OR batch_limit > 5000 THEN
    RAISE EXCEPTION 'email outbox redaction batch limit is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF report_only THEN
    RETURN QUERY
    WITH classified AS MATERIALIZED (
      SELECT
        "public"."classify_email_outbox_quarantine_redaction_v2"(
          candidate,
          cutoff_at
        ) AS raw_disposition
        FROM public.email_outbox AS candidate
    ), summary AS (
      SELECT CASE
               WHEN classified.raw_disposition IN (
                 'eligible_account',
                 'eligible_system',
                 'eligible_operation'
               ) THEN 'eligible'
               WHEN classified.raw_disposition IN (
                 'eligible_malformed', 'malformed'
               )
                 THEN 'malformed'
               ELSE classified.raw_disposition
             END AS disposition,
             pg_catalog.count(*)::bigint AS eligible
        FROM classified
       WHERE classified.raw_disposition IN (
         'eligible_account',
         'eligible_system',
         'eligible_operation',
         'eligible_malformed',
         'malformed',
         'blocked'
       )
       GROUP BY 1
    )
    SELECT dispositions.disposition,
           COALESCE(summary.eligible, 0)::bigint,
           0::bigint
      FROM (VALUES ('eligible'), ('blocked'), ('malformed'))
           AS dispositions(disposition)
      LEFT JOIN summary ON summary.disposition = dispositions.disposition
     ORDER BY CASE dispositions.disposition
       WHEN 'eligible' THEN 1
       WHEN 'blocked' THEN 2
       ELSE 3
     END;
    RETURN;
  END IF;

  RETURN QUERY
  WITH classified AS MATERIALIZED (
    SELECT candidate.id,
           COALESCE(
             candidate.quarantined_at,
             candidate.updated_at,
             candidate.created_at
           ) AS age_anchor,
           "public"."classify_email_outbox_quarantine_redaction_v2"(
             candidate,
             cutoff_at
           ) AS raw_disposition
      FROM public.email_outbox AS candidate
  ), eligible_rows AS MATERIALIZED (
    SELECT candidate.id,
           classified.raw_disposition
      FROM public.email_outbox AS candidate
      JOIN classified ON classified.id = candidate.id
     WHERE classified.raw_disposition IN (
       'eligible_account',
       'eligible_system',
       'eligible_operation',
       'eligible_malformed',
       'malformed'
     )
     ORDER BY classified.age_anchor, candidate.id
     LIMIT batch_limit
     FOR UPDATE OF candidate SKIP LOCKED
  ), redacted AS (
    UPDATE public.email_outbox AS outbox
       SET to_email =
             'redacted+' || outbox.id::text || '@invalid.local',
           variables = CASE
             WHEN eligible_rows.raw_disposition = 'eligible_system'
               THEN pg_catalog.jsonb_build_object(
                 '_mailOperationId', outbox.operation_id::text,
                 '_mailRecipient',
                   'redacted+' || outbox.id::text || '@invalid.local',
                 '_mailProducer', outbox.variables ->> '_mailProducer',
                 '_mailSourceId', outbox.variables ->> '_mailSourceId'
               ) || CASE
                 WHEN outbox.variables ? '_mailAudienceId'
                   THEN pg_catalog.jsonb_build_object(
                     '_mailAudienceId',
                     outbox.variables -> '_mailAudienceId'
                   )
                 ELSE '{}'::jsonb
               END
             ELSE '{}'::jsonb
           END,
           updated_at = pg_catalog.statement_timestamp()
      FROM eligible_rows
     WHERE outbox.id = eligible_rows.id
       AND "public"."classify_email_outbox_quarantine_redaction_v2"(
             outbox,
             cutoff_at
           ) = eligible_rows.raw_disposition
    RETURNING outbox.id, eligible_rows.raw_disposition
  ), summary AS (
    SELECT CASE
             WHEN classified.raw_disposition IN (
               'eligible_account',
               'eligible_system',
               'eligible_operation'
             ) THEN 'eligible'
             WHEN classified.raw_disposition IN (
               'eligible_malformed', 'malformed'
             )
               THEN 'malformed'
             ELSE classified.raw_disposition
           END AS disposition,
           pg_catalog.count(*)::bigint AS eligible
      FROM classified
     WHERE classified.raw_disposition IN (
       'eligible_account',
       'eligible_system',
       'eligible_operation',
       'eligible_malformed',
       'malformed',
       'blocked'
     )
     GROUP BY 1
  ), redacted_summary AS (
    SELECT CASE
             WHEN redacted.raw_disposition IN (
               'eligible_account',
               'eligible_system',
               'eligible_operation'
             ) THEN 'eligible'
             ELSE 'malformed'
           END AS disposition,
           pg_catalog.count(*)::bigint AS transitioned
      FROM redacted
     GROUP BY 1
  )
  SELECT dispositions.disposition,
         COALESCE(summary.eligible, 0)::bigint,
         COALESCE(redacted_summary.transitioned, 0)::bigint
    FROM (VALUES ('eligible'), ('blocked'), ('malformed'))
         AS dispositions(disposition)
    LEFT JOIN summary ON summary.disposition = dispositions.disposition
    LEFT JOIN redacted_summary
      ON redacted_summary.disposition = dispositions.disposition
   ORDER BY CASE dispositions.disposition
     WHEN 'eligible' THEN 1
     WHEN 'blocked' THEN 2
     ELSE 3
   END;
END
$function$;--> statement-breakpoint

ALTER FUNCTION
  "public"."classify_email_outbox_quarantine_redaction_v2"(
    "public"."email_outbox",
    timestamp with time zone
  ) OWNER TO learncoding_owner;--> statement-breakpoint
ALTER FUNCTION "public"."enforce_email_outbox_payload_immutable"()
  OWNER TO learncoding_owner;--> statement-breakpoint
ALTER FUNCTION
  "public"."redact_quarantined_email_outbox_authority_v2"(
    timestamp with time zone,
    integer
  ) OWNER TO learncoding_owner;--> statement-breakpoint

REVOKE ALL ON FUNCTION
  "public"."classify_email_outbox_quarantine_redaction_v2"(
    "public"."email_outbox",
    timestamp with time zone
  ) FROM PUBLIC, learncoding_owner, learncoding_app, learncoding_worker,
         learncoding_migrator, learncoding_ops CASCADE;--> statement-breakpoint
REVOKE ALL ON FUNCTION
  "public"."enforce_email_outbox_payload_immutable"()
  FROM PUBLIC, learncoding_owner, learncoding_app, learncoding_worker,
       learncoding_migrator, learncoding_ops CASCADE;--> statement-breakpoint
REVOKE ALL ON FUNCTION
  "public"."redact_quarantined_email_outbox_authority_v2"(
    timestamp with time zone,
    integer
  ) FROM PUBLIC, learncoding_owner, learncoding_app, learncoding_worker,
         learncoding_migrator, learncoding_ops CASCADE;--> statement-breakpoint

DO $scrub_function_acls$
DECLARE
  routine_oid pg_catalog.oid;
  acl_entry pg_catalog.record;
  routine_identity pg_catalog.text;
  grantee_name pg_catalog.name;
BEGIN
  FOREACH routine_oid IN ARRAY ARRAY[
    pg_catalog.to_regprocedure(
      'public.classify_email_outbox_quarantine_redaction_v2(public.email_outbox,timestamp with time zone)'
    )::oid,
    pg_catalog.to_regprocedure(
      'public.enforce_email_outbox_payload_immutable()'
    )::oid,
    pg_catalog.to_regprocedure(
      'public.redact_quarantined_email_outbox_authority_v2(timestamp with time zone,integer)'
    )::oid
  ]
  LOOP
    routine_identity := routine_oid::pg_catalog.regprocedure::text;
    FOR acl_entry IN
      SELECT expanded.grantee
        FROM pg_catalog.pg_proc AS routine
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            routine.proacl,
            pg_catalog.acldefault('f', routine.proowner)
          )
        ) AS expanded
       WHERE routine.oid = routine_oid
       GROUP BY expanded.grantee
    LOOP
      IF acl_entry.grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',
          routine_identity
        );
      ELSE
        grantee_name := pg_catalog.pg_get_userbyid(acl_entry.grantee);
        IF grantee_name IS NOT NULL THEN
          EXECUTE pg_catalog.format(
            'REVOKE ALL ON FUNCTION %s FROM %I CASCADE',
            routine_identity,
            grantee_name
          );
        END IF;
      END IF;
    END LOOP;
  END LOOP;
END
$scrub_function_acls$;--> statement-breakpoint

GRANT EXECUTE ON FUNCTION
  "public"."redact_quarantined_email_outbox_authority_v2"(
    timestamp with time zone,
    integer
  ) TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  "public"."redact_quarantined_email_outbox_authority_v2"(
    timestamp with time zone,
    integer
  ) TO learncoding_ops;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  "public"."enforce_email_outbox_payload_immutable"()
  TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  "public"."classify_email_outbox_quarantine_redaction_v2"(
    "public"."email_outbox",
    timestamp with time zone
  ) TO learncoding_owner;--> statement-breakpoint

DROP FUNCTION IF EXISTS
  "public"."redact_unresolved_email_outbox_authority"(
    timestamp with time zone,
    integer
  );--> statement-breakpoint
DROP FUNCTION IF EXISTS
  "public"."classify_email_outbox_retention_redaction"(
    "public"."email_outbox",
    timestamp with time zone
  );--> statement-breakpoint

DO $verify_terminal_catalog$
DECLARE
  classifier_oid pg_catalog.oid := pg_catalog.to_regprocedure(
    'public.classify_email_outbox_quarantine_redaction_v2(public.email_outbox,timestamp with time zone)'
  )::pg_catalog.oid;
  immutable_oid pg_catalog.oid := pg_catalog.to_regprocedure(
    'public.enforce_email_outbox_payload_immutable()'
  )::pg_catalog.oid;
  redactor_oid pg_catalog.oid := pg_catalog.to_regprocedure(
    'public.redact_quarantined_email_outbox_authority_v2(timestamp with time zone,integer)'
  )::pg_catalog.oid;
  function_acl pg_catalog.text[];
  expected_payload_columns CONSTANT pg_catalog.text[] := ARRAY[
    'delivery_hold_version', 'delivery_scope_key',
    'idempotency_authority_sha256', 'idempotency_authority_version',
    'idempotency_key', 'idempotency_original_payload_sha256', 'operation_id',
    'template', 'template_version', 'to_email', 'user_id', 'variables'
  ]::pg_catalog.text[];
BEGIN
  IF classifier_oid IS NULL OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS routine
      JOIN pg_catalog.pg_language AS language
        ON language.oid = routine.prolang
     WHERE routine.oid = classifier_oid
       AND pg_catalog.pg_get_userbyid(routine.proowner) = 'learncoding_owner'
       AND routine.prokind = 'f'
       AND routine.prosecdef
       AND routine.provolatile = 's'
       AND routine.proconfig =
             ARRAY['search_path=pg_catalog']::pg_catalog.text[]
       AND language.lanname = 'plpgsql'
  ) THEN
    RAISE EXCEPTION '0068 classifier catalog contract is invalid'
      USING ERRCODE = '42501';
  END IF;

  IF immutable_oid IS NULL OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS routine
      JOIN pg_catalog.pg_language AS language
        ON language.oid = routine.prolang
     WHERE routine.oid = immutable_oid
       AND pg_catalog.pg_get_userbyid(routine.proowner) = 'learncoding_owner'
       AND routine.prokind = 'f'
       AND NOT routine.prosecdef
       AND routine.provolatile = 'v'
       AND routine.proconfig =
             ARRAY['search_path=pg_catalog']::pg_catalog.text[]
       AND language.lanname = 'plpgsql'
  ) THEN
    RAISE EXCEPTION '0068 immutable trigger routine catalog contract is invalid'
      USING ERRCODE = '42501';
  END IF;

  IF redactor_oid IS NULL OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS routine
      JOIN pg_catalog.pg_language AS language
        ON language.oid = routine.prolang
     WHERE routine.oid = redactor_oid
       AND pg_catalog.pg_get_userbyid(routine.proowner) = 'learncoding_owner'
       AND routine.prokind = 'f'
       AND routine.prosecdef
       AND routine.provolatile = 'v'
       AND routine.proconfig =
             ARRAY['search_path=pg_catalog']::pg_catalog.text[]
       AND language.lanname = 'plpgsql'
  ) THEN
    RAISE EXCEPTION '0068 redactor catalog contract is invalid'
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(
           pg_catalog.array_agg(
             pg_catalog.format(
               '%s|%s|%s|%s|%s',
               reviewed.routine_label,
               CASE WHEN access.grantee = 0
                 THEN 'PUBLIC'
                 ELSE pg_catalog.pg_get_userbyid(access.grantee)
               END,
               CASE WHEN access.grantor = 0
                 THEN 'PUBLIC'
                 ELSE pg_catalog.pg_get_userbyid(access.grantor)
               END,
               pg_catalog.lower(access.privilege_type),
               access.is_grantable::pg_catalog.text
             )
             ORDER BY
               reviewed.routine_label,
               CASE WHEN access.grantee = 0
                 THEN 'PUBLIC'
                 ELSE pg_catalog.pg_get_userbyid(access.grantee)
               END,
               CASE WHEN access.grantor = 0
                 THEN 'PUBLIC'
                 ELSE pg_catalog.pg_get_userbyid(access.grantor)
               END,
               pg_catalog.lower(access.privilege_type),
               access.is_grantable
           ),
           ARRAY[]::pg_catalog.text[]
         )
    INTO function_acl
    FROM (VALUES
      ('classifier'::pg_catalog.text, classifier_oid),
      ('immutable'::pg_catalog.text, immutable_oid),
      ('redactor'::pg_catalog.text, redactor_oid)
    ) AS reviewed(routine_label, routine_oid)
    JOIN pg_catalog.pg_proc AS routine
      ON routine.oid = reviewed.routine_oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        routine.proacl,
        pg_catalog.acldefault('f', routine.proowner)
      )
    ) AS access;

  IF function_acl IS DISTINCT FROM ARRAY[
       'classifier|learncoding_owner|learncoding_owner|execute|false',
       'immutable|learncoding_owner|learncoding_owner|execute|false',
       'redactor|learncoding_ops|learncoding_owner|execute|false',
       'redactor|learncoding_owner|learncoding_owner|execute|false'
     ]::pg_catalog.text[]
  THEN
    RAISE EXCEPTION '0068 function ACL contract is invalid'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
     WHERE trigger_row.tgrelid =
             'public.email_outbox'::pg_catalog.regclass
       AND trigger_row.tgname = 'email_outbox_payload_immutable'
       AND NOT trigger_row.tgisinternal
       AND trigger_row.tgconstraint = 0
       AND trigger_row.tgconstrrelid = 0
       AND trigger_row.tgqual IS NULL
       AND trigger_row.tgtype = 19
       AND trigger_row.tgenabled = 'A'
       AND trigger_row.tgfoid = immutable_oid
       AND (
         SELECT pg_catalog.array_agg(
                  attribute.attname::pg_catalog.text
                  ORDER BY attribute.attname::pg_catalog.text
                )
           FROM pg_catalog.unnest(
                  trigger_row.tgattr::pg_catalog.int2[]
                ) AS trigger_attribute(attnum)
           JOIN pg_catalog.pg_attribute AS attribute
             ON attribute.attrelid = trigger_row.tgrelid
            AND attribute.attnum = trigger_attribute.attnum
       ) IS NOT DISTINCT FROM expected_payload_columns
  ) THEN
    RAISE EXCEPTION '0068 payload immutable trigger contract is invalid'
      USING ERRCODE = '42501';
  END IF;
END
$verify_terminal_catalog$;
