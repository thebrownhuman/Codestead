-- Forward-only successor to the published 0062 retention-redaction migration.
CREATE OR REPLACE FUNCTION "public"."classify_email_outbox_retention_redaction"(
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
  redacted_email text;
  expected_system_variables jsonb;
  is_account_scope boolean;
  is_system_scope boolean;
BEGIN
  IF candidate.id IS NULL OR cutoff_at IS NULL THEN
    RETURN NULL;
  END IF;

  is_account_scope := candidate.user_id IS NOT NULL
    AND candidate.delivery_scope_key IS NOT DISTINCT FROM 'a:' || candidate.user_id;
  is_system_scope := candidate.user_id IS NULL
    AND candidate.delivery_scope_key IS NOT DISTINCT FROM 's:' || candidate.operation_id::text;

  IF NOT is_account_scope AND NOT is_system_scope THEN
    RETURN NULL;
  END IF;

  IF candidate.status IS DISTINCT FROM 'quarantined'::public.notification_status
     OR candidate.provider_call_started IS NULL
     OR candidate.provider_message_id IS NOT NULL
     OR candidate.sent_at IS NOT NULL
     OR candidate.adapter IS DISTINCT FROM 'gmail'
     OR candidate.updated_at IS NULL
     OR candidate.updated_at >= cutoff_at THEN
    RETURN NULL;
  END IF;

  redacted_email := 'redacted+' || candidate.id::text || '@invalid.local';
  IF is_system_scope THEN
    IF candidate.template_version IS DISTINCT FROM '1'
       OR candidate.variables ->> '_mailOperationId' IS DISTINCT FROM candidate.operation_id::text
       OR candidate.variables ->> '_mailRecipient' IS DISTINCT FROM candidate.to_email
       OR NOT COALESCE(
         candidate.variables ->> '_mailSourceId'
           ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
         false
       )
       OR NOT (
         (candidate.template = 'access-request-admin'
           AND candidate.variables ->> '_mailProducer' IS NOT DISTINCT FROM 'access-request-admin')
         OR (candidate.template = 'invitation'
           AND candidate.variables ->> '_mailProducer' IS NOT DISTINCT FROM 'access-request-approved')
         OR (candidate.template = 'access-rejected'
           AND candidate.variables ->> '_mailProducer' IS NOT DISTINCT FROM 'access-request-rejected')
       ) THEN
      RETURN 'malformed';
    END IF;

    expected_system_variables := pg_catalog.jsonb_build_object(
      '_mailOperationId', candidate.operation_id::text,
      '_mailRecipient', redacted_email,
      '_mailProducer', candidate.variables ->> '_mailProducer',
      '_mailSourceId', candidate.variables ->> '_mailSourceId'
    );
    IF candidate.to_email IS NOT DISTINCT FROM redacted_email
       AND candidate.variables IS NOT DISTINCT FROM expected_system_variables THEN
      RETURN NULL;
    END IF;
  ELSIF candidate.to_email IS NOT DISTINCT FROM redacted_email
        AND candidate.variables IS NOT DISTINCT FROM '{}'::jsonb THEN
    RETURN NULL;
  END IF;

  IF candidate.quarantined_at IS NULL
     OR NULLIF(pg_catalog.btrim(candidate.last_error_code), '') IS NULL THEN
    RETURN 'malformed';
  END IF;
  IF candidate.quarantined_at >= cutoff_at THEN
    RETURN NULL;
  END IF;

  IF candidate.claim_token IS NULL
     AND candidate.claim_owner IS NULL
     AND candidate.lease_expires_at IS NULL THEN
    IF is_system_scope THEN
      RETURN 'eligible_system';
    END IF;
    RETURN 'eligible_account';
  END IF;

  IF candidate.claim_token IS NOT NULL
     AND candidate.claim_owner IS NOT NULL
     AND candidate.lease_expires_at IS NOT NULL THEN
    RETURN 'blocked';
  END IF;

  RETURN 'malformed';
END
$function$;--> statement-breakpoint
ALTER FUNCTION "public"."classify_email_outbox_retention_redaction"(
  "public"."email_outbox",
  timestamp with time zone
) OWNER TO learncoding_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."classify_email_outbox_retention_redaction"(
  "public"."email_outbox",
  timestamp with time zone
) FROM PUBLIC, learncoding_app, learncoding_worker, learncoding_migrator, learncoding_ops;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."enforce_email_outbox_payload_immutable"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
DECLARE
  redaction_disposition text;
  expected_email text;
  expected_variables jsonb;
BEGIN
  IF current_user = 'learncoding_owner'
     AND session_user = 'learncoding_ops' THEN
    redaction_disposition := "public"."classify_email_outbox_retention_redaction"(
      OLD,
      pg_catalog.statement_timestamp() - interval '30 days'
    );
    expected_email := 'redacted+' || OLD.id::text || '@invalid.local';
    expected_variables := CASE WHEN redaction_disposition = 'eligible_system'
      THEN pg_catalog.jsonb_build_object(
        '_mailOperationId', OLD.operation_id::text,
        '_mailRecipient', expected_email,
        '_mailProducer', OLD.variables ->> '_mailProducer',
        '_mailSourceId', OLD.variables ->> '_mailSourceId'
      )
      ELSE '{}'::jsonb
    END;

    IF redaction_disposition IN ('eligible_account', 'eligible_system')
       AND NEW.adapter = 'gmail'
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
       AND OLD.provider_call_started IS NOT DISTINCT FROM NEW.provider_call_started
       AND OLD.adapter IS NOT DISTINCT FROM NEW.adapter
       AND OLD.provider_message_id IS NOT DISTINCT FROM NEW.provider_message_id
       AND OLD.next_attempt_at IS NOT DISTINCT FROM NEW.next_attempt_at
       AND OLD.sent_at IS NOT DISTINCT FROM NEW.sent_at
       AND OLD.quarantined_at IS NOT DISTINCT FROM NEW.quarantined_at
       AND OLD.last_error_code IS NOT DISTINCT FROM NEW.last_error_code
       AND OLD.created_at IS NOT DISTINCT FROM NEW.created_at THEN
      RETURN NEW;
    END IF;
  END IF;

  IF OLD.user_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'email_outbox.user_id is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.to_email IS DISTINCT FROM NEW.to_email THEN
    RAISE EXCEPTION 'email_outbox.to_email is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.template IS DISTINCT FROM NEW.template THEN
    RAISE EXCEPTION 'email_outbox.template is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.template_version IS DISTINCT FROM NEW.template_version THEN
    RAISE EXCEPTION 'email_outbox.template_version is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.variables IS DISTINCT FROM NEW.variables THEN
    RAISE EXCEPTION 'email_outbox.variables is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key THEN
    RAISE EXCEPTION 'email_outbox.idempotency_key is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.operation_id IS DISTINCT FROM NEW.operation_id THEN
    RAISE EXCEPTION 'email_outbox.operation_id is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.delivery_scope_key IS DISTINCT FROM NEW.delivery_scope_key THEN
    RAISE EXCEPTION 'email_outbox.delivery_scope_key is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;--> statement-breakpoint
ALTER FUNCTION "public"."enforce_email_outbox_payload_immutable"()
  OWNER TO learncoding_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."enforce_email_outbox_payload_immutable"()
  FROM PUBLIC, learncoding_app, learncoding_worker, learncoding_migrator, learncoding_ops;--> statement-breakpoint
DROP FUNCTION "public"."redact_unresolved_email_outbox_authority"(
  timestamp with time zone,
  integer
);--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."redact_unresolved_email_outbox_authority"(
  "cutoff_at" timestamp with time zone,
  "batch_limit" integer
)
RETURNS TABLE("disposition" text, "eligible" bigint, "transitioned" bigint)
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
     OR cutoff_at > pg_catalog.statement_timestamp() - interval '30 days' THEN
    RAISE EXCEPTION 'email outbox redaction cutoff violates retention policy'
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
             "public"."classify_email_outbox_retention_redaction"(candidate, cutoff_at) AS raw_disposition
        FROM public.email_outbox AS candidate
    ), summary AS (
      SELECT CASE
               WHEN classified.raw_disposition IN ('eligible_account', 'eligible_system')
                 THEN 'eligible'
               ELSE classified.raw_disposition
             END AS disposition,
             pg_catalog.count(*)::bigint AS eligible
        FROM classified
       WHERE classified.raw_disposition IN (
         'eligible_account', 'eligible_system', 'blocked', 'malformed'
       )
       GROUP BY CASE
         WHEN classified.raw_disposition IN ('eligible_account', 'eligible_system')
           THEN 'eligible'
         ELSE classified.raw_disposition
       END
    )
    SELECT dispositions.disposition,
           COALESCE(summary.eligible, 0)::bigint AS eligible,
           0::bigint AS transitioned
      FROM (VALUES ('eligible'), ('blocked'), ('malformed')) AS dispositions(disposition)
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
           candidate.updated_at,
           "public"."classify_email_outbox_retention_redaction"(candidate, cutoff_at) AS raw_disposition
      FROM public.email_outbox AS candidate
  ), eligible_rows AS MATERIALIZED (
    SELECT candidate.id
      FROM public.email_outbox AS candidate
      JOIN classified ON classified.id = candidate.id
     WHERE classified.raw_disposition IN ('eligible_account', 'eligible_system')
     ORDER BY candidate.updated_at, candidate.id
     LIMIT batch_limit
     FOR UPDATE OF candidate SKIP LOCKED
  ), redacted AS (
    UPDATE public.email_outbox AS outbox
       SET to_email = 'redacted+' || outbox.id::text || '@invalid.local',
           variables = CASE WHEN outbox.user_id IS NULL
             THEN pg_catalog.jsonb_build_object(
               '_mailOperationId', outbox.operation_id::text,
               '_mailRecipient', 'redacted+' || outbox.id::text || '@invalid.local',
               '_mailProducer', outbox.variables ->> '_mailProducer',
               '_mailSourceId', outbox.variables ->> '_mailSourceId'
             )
             ELSE '{}'::jsonb
           END,
           updated_at = pg_catalog.statement_timestamp()
      FROM eligible_rows
     WHERE outbox.id = eligible_rows.id
       AND "public"."classify_email_outbox_retention_redaction"(outbox, cutoff_at)
             IN ('eligible_account', 'eligible_system')
    RETURNING outbox.id
  ), summary AS (
    SELECT CASE
             WHEN classified.raw_disposition IN ('eligible_account', 'eligible_system')
               THEN 'eligible'
             ELSE classified.raw_disposition
           END AS disposition,
           pg_catalog.count(*)::bigint AS eligible
      FROM classified
     WHERE classified.raw_disposition IN (
       'eligible_account', 'eligible_system', 'blocked', 'malformed'
     )
     GROUP BY CASE
       WHEN classified.raw_disposition IN ('eligible_account', 'eligible_system')
         THEN 'eligible'
       ELSE classified.raw_disposition
     END
  ), redacted_summary AS (
    SELECT pg_catalog.count(*)::bigint AS transitioned FROM redacted
  )
  SELECT dispositions.disposition,
         COALESCE(summary.eligible, 0)::bigint AS eligible,
         CASE WHEN dispositions.disposition = 'eligible'
           THEN redacted_summary.transitioned
           ELSE 0::bigint
         END AS transitioned
    FROM (VALUES ('eligible'), ('blocked'), ('malformed')) AS dispositions(disposition)
    LEFT JOIN summary ON summary.disposition = dispositions.disposition
    CROSS JOIN redacted_summary
   ORDER BY CASE dispositions.disposition
     WHEN 'eligible' THEN 1
     WHEN 'blocked' THEN 2
     ELSE 3
   END;
END
$function$;--> statement-breakpoint
ALTER FUNCTION "public"."redact_unresolved_email_outbox_authority"(
  timestamp with time zone,
  integer
) OWNER TO learncoding_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."redact_unresolved_email_outbox_authority"(
  timestamp with time zone,
  integer
) FROM PUBLIC, learncoding_app, learncoding_worker, learncoding_migrator, learncoding_ops;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."redact_unresolved_email_outbox_authority"(
  timestamp with time zone,
  integer
) TO learncoding_ops;