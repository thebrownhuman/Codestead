-- Forward-only SQL component. Journal/snapshot/ledger metadata is added only
-- after the exact reviewed 0065/0066 predecessor chain is frozen.
DO $preflight$
BEGIN
  IF (
    SELECT pg_catalog.count(*) <> 3
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid =
             'public.email_outbox'::pg_catalog.regclass
       AND attribute.attname IN (
         'provider_correlation_version',
         'provider_evidence_version',
         'provider_evidence_sha256'
       )
       AND NOT attribute.attisdropped
  )
  OR pg_catalog.to_regprocedure(
       'public.enforce_email_outbox_provider_correlation_evidence()'
     ) IS NULL
  OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_record
     WHERE constraint_record.conrelid =
             'public.email_outbox'::pg_catalog.regclass
       AND constraint_record.conname =
             'email_outbox_provider_correlation_evidence_valid'
       AND constraint_record.contype = 'c'
       AND constraint_record.convalidated
       AND NOT constraint_record.connoinherit
  )
  OR NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_record
     WHERE trigger_record.tgrelid =
             'public.email_outbox'::pg_catalog.regclass
       AND trigger_record.tgname =
             'email_outbox_provider_correlation_evidence_guard'
       AND NOT trigger_record.tgisinternal
       AND trigger_record.tgfoid = pg_catalog.to_regprocedure(
             'public.enforce_email_outbox_provider_correlation_evidence()'
           )
       AND trigger_record.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION
      'email outbox quarantine redaction predecessor is invalid'
      USING ERRCODE = '23514';
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
  age_anchor timestamp with time zone;
  expected_email text;
  expected_variables jsonb;
  raw_disposition text;
BEGIN
  IF candidate.id IS NULL
     OR cutoff_at IS NULL
     OR candidate.status IS DISTINCT FROM
          'quarantined'::public.notification_status THEN
    RETURN NULL;
  END IF;

  age_anchor := COALESCE(
    candidate.quarantined_at,
    candidate.updated_at,
    candidate.created_at
  );
  IF age_anchor IS NULL OR age_anchor >= cutoff_at THEN
    RETURN NULL;
  END IF;

  expected_email :=
    'redacted+' || candidate.id::text || '@invalid.local';
  IF candidate.user_id IS NOT NULL
     AND candidate.delivery_scope_key IS NOT DISTINCT FROM
           'a:' || candidate.user_id THEN
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
        ) THEN
    raw_disposition := 'eligible_system';
    expected_variables := pg_catalog.jsonb_build_object(
      '_mailOperationId', candidate.operation_id::text,
      '_mailRecipient', expected_email,
      '_mailProducer', candidate.variables ->> '_mailProducer',
      '_mailSourceId', candidate.variables ->> '_mailSourceId'
    );
  ELSIF candidate.user_id IS NULL
        AND candidate.delivery_scope_key IS NOT DISTINCT FROM
              'o:' || candidate.operation_id::text THEN
    raw_disposition := 'eligible_operation';
    expected_variables := '{}'::jsonb;
  ELSE
    -- A validated delivery-scope constraint prevents this shape in a healthy
    -- catalog. If an inherited or manually damaged row exists, payload
    -- minimization remains safe and the non-PII malformed scope is retained.
    raw_disposition := 'eligible_malformed';
    expected_variables := '{}'::jsonb;
  END IF;

  IF candidate.to_email IS NOT DISTINCT FROM expected_email
     AND candidate.variables IS NOT DISTINCT FROM expected_variables THEN
    RETURN NULL;
  END IF;

  IF candidate.claim_token IS NULL
     AND candidate.claim_owner IS NULL
     AND candidate.lease_expires_at IS NULL THEN
    RETURN raw_disposition;
  END IF;

  RETURN 'blocked';
END
$function$;--> statement-breakpoint
ALTER FUNCTION
  "public"."classify_email_outbox_quarantine_redaction_v2"(
    "public"."email_outbox",
    timestamp with time zone
  ) OWNER TO learncoding_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION
  "public"."classify_email_outbox_quarantine_redaction_v2"(
    "public"."email_outbox",
    timestamp with time zone
  ) FROM PUBLIC, learncoding_app, learncoding_worker,
         learncoding_migrator, learncoding_ops;--> statement-breakpoint
DO $seal_classifier_acl$
DECLARE
  candidate_grantee oid;
  candidate_name name;
BEGIN
  FOR candidate_grantee IN
    SELECT DISTINCT expanded.grantee
      FROM pg_catalog.pg_proc AS routine
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        CASE
          WHEN routine.proacl IS NULL
            OR pg_catalog.cardinality(routine.proacl) = 0
            THEN pg_catalog.acldefault('f', routine.proowner)
          ELSE routine.proacl
        END
      ) AS expanded
     WHERE routine.oid = pg_catalog.to_regprocedure(
       'public.classify_email_outbox_quarantine_redaction_v2(public.email_outbox,timestamp with time zone)'
     )
       AND expanded.grantee <> routine.proowner
  LOOP
    IF candidate_grantee = 0 THEN
      EXECUTE
        'REVOKE ALL ON FUNCTION ' ||
        'public.classify_email_outbox_quarantine_redaction_v2(' ||
        'public.email_outbox, timestamp with time zone) FROM PUBLIC';
    ELSE
      candidate_name := pg_catalog.pg_get_userbyid(candidate_grantee);
      IF candidate_name IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL ON FUNCTION ' ||
          'public.classify_email_outbox_quarantine_redaction_v2(' ||
          'public.email_outbox, timestamp with time zone) FROM %I',
          candidate_name
        );
      END IF;
    END IF;
  END LOOP;
END
$seal_classifier_acl$;--> statement-breakpoint
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
     AND session_user = 'learncoding_ops' THEN
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
        )
        ELSE '{}'::jsonb
      END;

    IF redaction_disposition IN (
         'eligible_account',
         'eligible_system',
         'eligible_operation',
         'eligible_malformed'
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
       AND OLD.provider_message_id
             IS NOT DISTINCT FROM NEW.provider_message_id
       AND OLD.provider_correlation_version
             IS NOT DISTINCT FROM NEW.provider_correlation_version
       AND OLD.provider_evidence_version
             IS NOT DISTINCT FROM NEW.provider_evidence_version
       AND OLD.provider_evidence_sha256
             IS NOT DISTINCT FROM NEW.provider_evidence_sha256
       AND OLD.next_attempt_at IS NOT DISTINCT FROM NEW.next_attempt_at
       AND OLD.sent_at IS NOT DISTINCT FROM NEW.sent_at
       AND OLD.quarantined_at IS NOT DISTINCT FROM NEW.quarantined_at
       AND OLD.last_error_code IS NOT DISTINCT FROM NEW.last_error_code
       AND OLD.created_at IS NOT DISTINCT FROM NEW.created_at THEN
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
ALTER FUNCTION "public"."enforce_email_outbox_payload_immutable"()
  OWNER TO learncoding_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION
  "public"."enforce_email_outbox_payload_immutable"()
  FROM PUBLIC, learncoding_app, learncoding_worker,
       learncoding_migrator, learncoding_ops;--> statement-breakpoint
DO $seal_payload_trigger_acl$
DECLARE
  candidate_grantee oid;
  candidate_name name;
BEGIN
  FOR candidate_grantee IN
    SELECT DISTINCT expanded.grantee
      FROM pg_catalog.pg_proc AS routine
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        CASE
          WHEN routine.proacl IS NULL
            OR pg_catalog.cardinality(routine.proacl) = 0
            THEN pg_catalog.acldefault('f', routine.proowner)
          ELSE routine.proacl
        END
      ) AS expanded
     WHERE routine.oid = pg_catalog.to_regprocedure(
       'public.enforce_email_outbox_payload_immutable()'
     )
       AND expanded.grantee <> routine.proowner
  LOOP
    IF candidate_grantee = 0 THEN
      EXECUTE
        'REVOKE ALL ON FUNCTION ' ||
        'public.enforce_email_outbox_payload_immutable() FROM PUBLIC';
    ELSE
      candidate_name := pg_catalog.pg_get_userbyid(candidate_grantee);
      IF candidate_name IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL ON FUNCTION ' ||
          'public.enforce_email_outbox_payload_immutable() FROM %I',
          candidate_name
        );
      END IF;
    END IF;
  END LOOP;
END
$seal_payload_trigger_acl$;--> statement-breakpoint
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
     OR current_user <> 'learncoding_owner' THEN
    RAISE EXCEPTION 'email outbox redaction caller is not authorized'
      USING ERRCODE = '42501';
  END IF;
  IF cutoff_at IS NULL
     OR cutoff_at >
          pg_catalog.statement_timestamp() - interval '30 days' THEN
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
      SELECT candidate.id,
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
               WHEN classified.raw_disposition = 'eligible_malformed'
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
         'blocked'
       )
       GROUP BY CASE
         WHEN classified.raw_disposition IN (
           'eligible_account',
           'eligible_system',
           'eligible_operation'
         ) THEN 'eligible'
         WHEN classified.raw_disposition = 'eligible_malformed'
           THEN 'malformed'
         ELSE classified.raw_disposition
       END
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
       'eligible_malformed'
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
               )
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
             WHEN classified.raw_disposition = 'eligible_malformed'
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
       'blocked'
     )
     GROUP BY CASE
       WHEN classified.raw_disposition IN (
         'eligible_account',
         'eligible_system',
         'eligible_operation'
       ) THEN 'eligible'
       WHEN classified.raw_disposition = 'eligible_malformed'
         THEN 'malformed'
       ELSE classified.raw_disposition
     END
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
     GROUP BY CASE
       WHEN redacted.raw_disposition IN (
         'eligible_account',
         'eligible_system',
         'eligible_operation'
       ) THEN 'eligible'
       ELSE 'malformed'
     END
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
  "public"."redact_quarantined_email_outbox_authority_v2"(
    timestamp with time zone,
    integer
  ) OWNER TO learncoding_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION
  "public"."redact_quarantined_email_outbox_authority_v2"(
    timestamp with time zone,
    integer
  ) FROM PUBLIC, learncoding_app, learncoding_worker,
         learncoding_migrator, learncoding_ops;--> statement-breakpoint
DO $seal_redactor_acl$
DECLARE
  candidate_grantee oid;
  candidate_name name;
BEGIN
  FOR candidate_grantee IN
    SELECT DISTINCT expanded.grantee
      FROM pg_catalog.pg_proc AS routine
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        CASE
          WHEN routine.proacl IS NULL
            OR pg_catalog.cardinality(routine.proacl) = 0
            THEN pg_catalog.acldefault('f', routine.proowner)
          ELSE routine.proacl
        END
      ) AS expanded
     WHERE routine.oid = pg_catalog.to_regprocedure(
       'public.redact_quarantined_email_outbox_authority_v2(timestamp with time zone,integer)'
     )
       AND expanded.grantee <> routine.proowner
  LOOP
    IF candidate_grantee = 0 THEN
      EXECUTE
        'REVOKE ALL ON FUNCTION ' ||
        'public.redact_quarantined_email_outbox_authority_v2(' ||
        'timestamp with time zone, integer) FROM PUBLIC';
    ELSE
      candidate_name := pg_catalog.pg_get_userbyid(candidate_grantee);
      IF candidate_name IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL ON FUNCTION ' ||
          'public.redact_quarantined_email_outbox_authority_v2(' ||
          'timestamp with time zone, integer) FROM %I',
          candidate_name
        );
      END IF;
    END IF;
  END LOOP;
END
$seal_redactor_acl$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  "public"."redact_quarantined_email_outbox_authority_v2"(
    timestamp with time zone,
    integer
  ) TO learncoding_ops;--> statement-breakpoint
DROP FUNCTION IF EXISTS
  "public"."redact_unresolved_email_outbox_authority"(
    timestamp with time zone,
    integer
  );--> statement-breakpoint
DROP FUNCTION IF EXISTS
  "public"."classify_email_outbox_retention_redaction"(
    "public"."email_outbox",
    timestamp with time zone
  );
