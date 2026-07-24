CREATE OR REPLACE FUNCTION "public"."enforce_email_outbox_payload_immutable"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  IF current_user = 'learncoding_owner'
     AND session_user = 'learncoding_ops'
     AND OLD.user_id IS NOT NULL
     AND OLD.delivery_scope_key = 'a:' || OLD.user_id
     AND OLD.status = 'quarantined'
     AND OLD.provider_call_started IS NOT NULL
     AND OLD.provider_message_id IS NULL
     AND OLD.sent_at IS NULL
     AND OLD.lease_expires_at IS NOT NULL
     AND OLD.lease_expires_at <= pg_catalog.statement_timestamp()
     AND OLD.adapter = 'gmail'
     AND NEW.adapter = 'gmail'
     AND OLD.updated_at < pg_catalog.statement_timestamp() - interval '30 days'
     AND NEW.to_email = 'redacted+' || OLD.id::text || '@invalid.local'
     AND NEW.variables = '{}'::jsonb
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
CREATE OR REPLACE FUNCTION "public"."redact_unresolved_email_outbox_authority"(
  "cutoff_at" timestamp with time zone,
  "batch_limit" integer
)
RETURNS TABLE("id" uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
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
  IF batch_limit IS NULL OR batch_limit < 1 OR batch_limit > 5000 THEN
    RAISE EXCEPTION 'email outbox redaction batch limit is invalid'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH eligible AS (
    SELECT candidate.id
      FROM public.email_outbox AS candidate
     WHERE candidate.user_id IS NOT NULL
       AND candidate.delivery_scope_key = 'a:' || candidate.user_id
       AND candidate.status = 'quarantined'
       AND candidate.provider_call_started IS NOT NULL
       AND candidate.provider_message_id IS NULL
       AND candidate.sent_at IS NULL
       AND candidate.adapter = 'gmail'
       AND candidate.lease_expires_at IS NOT NULL
       AND candidate.lease_expires_at <= pg_catalog.statement_timestamp()
       AND candidate.updated_at < cutoff_at
       AND candidate.updated_at
             < pg_catalog.statement_timestamp() - interval '30 days'
       AND (
         candidate.to_email IS DISTINCT FROM
           'redacted+' || candidate.id::text || '@invalid.local'
         OR candidate.variables IS DISTINCT FROM '{}'::jsonb
       )
     ORDER BY candidate.updated_at, candidate.id
     LIMIT batch_limit
     FOR UPDATE OF candidate SKIP LOCKED
  )
  UPDATE public.email_outbox AS outbox
     SET to_email = 'redacted+' || outbox.id::text || '@invalid.local',
         variables = '{}'::jsonb,
         updated_at = pg_catalog.statement_timestamp()
    FROM eligible
   WHERE outbox.id = eligible.id
  RETURNING outbox.id;
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
