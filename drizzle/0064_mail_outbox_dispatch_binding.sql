LOCK TABLE public.email_outbox IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.email_outbox
     WHERE (
       provider_call_started IS NULL
       AND (adapter IS NOT NULL OR provider_message_id IS NOT NULL)
     )
     OR (
       provider_call_started IS NOT NULL
       AND (adapter IS NULL OR adapter NOT IN ('gmail', 'console'))
     )
     OR (
       provider_call_started IS NOT NULL
       AND status NOT IN ('sending', 'sent', 'failed', 'quarantined')
     )
  ) THEN
    RAISE EXCEPTION
      'email outbox provider state is invalid before dispatch binding migration'
      USING ERRCODE = '23514';
  END IF;
END
$preflight$;--> statement-breakpoint
ALTER TABLE public.email_outbox
  ADD COLUMN "dispatch_binding_version" text,
  ADD COLUMN "dispatch_binding_sha256" text;--> statement-breakpoint
ALTER TABLE public.email_outbox
  ADD CONSTRAINT "email_outbox_dispatch_binding_valid"
  CHECK (
    (
      provider_call_started IS NULL
      AND adapter IS NULL
      AND provider_message_id IS NULL
      AND dispatch_binding_version IS NULL
      AND dispatch_binding_sha256 IS NULL
    )
    OR (
      provider_call_started IS NOT NULL
      AND status IN ('sending', 'sent', 'failed', 'quarantined')
      AND (
        (
          adapter = 'gmail'
          AND (
            (
              dispatch_binding_version IS NULL
              AND dispatch_binding_sha256 IS NULL
            )
            OR (
              dispatch_binding_version = 'gmail-raw-v1'
              AND dispatch_binding_sha256 ~ '^[0-9a-f]{64}$'
            )
          )
        )
        OR (
          adapter = 'console'
          AND (
            (
              dispatch_binding_version IS NULL
              AND dispatch_binding_sha256 IS NULL
            )
            OR (
              dispatch_binding_version = 'console-json-v1'
              AND dispatch_binding_sha256 ~ '^[0-9a-f]{64}$'
            )
          )
        )
      )
    )
  ) NOT VALID;--> statement-breakpoint
ALTER TABLE public.email_outbox
  VALIDATE CONSTRAINT email_outbox_dispatch_binding_valid;--> statement-breakpoint
CREATE FUNCTION "public"."enforce_email_outbox_dispatch_binding"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.provider_call_started IS NOT NULL
       OR NEW.adapter IS NOT NULL
       OR NEW.provider_message_id IS NOT NULL
       OR NEW.dispatch_binding_version IS NOT NULL
       OR NEW.dispatch_binding_sha256 IS NOT NULL THEN
      RAISE EXCEPTION 'email outbox dispatch binding insert is invalid'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.provider_call_started IS NOT DISTINCT FROM NEW.provider_call_started
     AND OLD.adapter IS NOT DISTINCT FROM NEW.adapter
     AND OLD.dispatch_binding_version
           IS NOT DISTINCT FROM NEW.dispatch_binding_version
     AND OLD.dispatch_binding_sha256
           IS NOT DISTINCT FROM NEW.dispatch_binding_sha256 THEN
    RETURN NEW;
  END IF;

  IF OLD.provider_call_started IS NOT NULL
     OR OLD.adapter IS NOT NULL
     OR OLD.dispatch_binding_version IS NOT NULL
     OR OLD.dispatch_binding_sha256 IS NOT NULL THEN
    RAISE EXCEPTION 'email outbox dispatch binding is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF current_user <> 'learncoding_worker'
     OR session_user <> 'learncoding_worker' THEN
    RAISE EXCEPTION 'email outbox dispatch arm requires worker identity'
      USING ERRCODE = '42501';
  END IF;

  IF (
    OLD.id IS NOT DISTINCT FROM NEW.id
    AND OLD.user_id IS NOT DISTINCT FROM NEW.user_id
    AND OLD.to_email IS NOT DISTINCT FROM NEW.to_email
    AND OLD.template IS NOT DISTINCT FROM NEW.template
    AND OLD.template_version IS NOT DISTINCT FROM NEW.template_version
    AND OLD.variables IS NOT DISTINCT FROM NEW.variables
    AND OLD.idempotency_key IS NOT DISTINCT FROM NEW.idempotency_key
    AND OLD.operation_id IS NOT DISTINCT FROM NEW.operation_id
    AND OLD.delivery_scope_key IS NOT DISTINCT FROM NEW.delivery_scope_key
    AND OLD.status = 'sending'
    AND NEW.status = 'sending'
    AND OLD.attempt_count IS NOT DISTINCT FROM NEW.attempt_count
    AND OLD.claim_token IS NOT NULL
    AND OLD.claim_token IS NOT DISTINCT FROM NEW.claim_token
    AND OLD.claim_owner IS NOT NULL
    AND pg_catalog.btrim(OLD.claim_owner) <> ''
    AND OLD.claim_owner IS NOT DISTINCT FROM NEW.claim_owner
    AND OLD.claim_version > 0
    AND OLD.claim_version IS NOT DISTINCT FROM NEW.claim_version
    AND OLD.lease_expires_at > pg_catalog.statement_timestamp()
    AND NEW.lease_expires_at
          >= pg_catalog.statement_timestamp() + interval '15 seconds'
    AND NEW.lease_expires_at
          <= pg_catalog.statement_timestamp() + interval '300 seconds'
    AND NEW.provider_call_started
          = pg_catalog.statement_timestamp()
    AND (
      (
        NEW.adapter = 'gmail'
        AND NEW.dispatch_binding_version = 'gmail-raw-v1'
      )
      OR (
        NEW.adapter = 'console'
        AND NEW.dispatch_binding_version = 'console-json-v1'
      )
    )
    AND NEW.dispatch_binding_sha256 ~ '^[0-9a-f]{64}$'
    AND OLD.provider_message_id IS NULL
    AND NEW.provider_message_id IS NULL
    AND OLD.next_attempt_at IS NOT DISTINCT FROM NEW.next_attempt_at
    AND OLD.sent_at IS NULL
    AND NEW.sent_at IS NULL
    AND OLD.quarantined_at IS NULL
    AND NEW.quarantined_at IS NULL
    AND OLD.last_error_code IS NOT DISTINCT FROM NEW.last_error_code
    AND OLD.created_at IS NOT DISTINCT FROM NEW.created_at
    AND NEW.updated_at = pg_catalog.statement_timestamp()
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'email outbox dispatch binding transition is invalid'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;--> statement-breakpoint
ALTER FUNCTION "public"."enforce_email_outbox_dispatch_binding"()
  OWNER TO learncoding_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."enforce_email_outbox_dispatch_binding"()
  FROM PUBLIC, learncoding_app, learncoding_worker, learncoding_migrator,
       learncoding_ops, learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."enforce_email_outbox_dispatch_binding"()
  TO learncoding_owner;--> statement-breakpoint
CREATE TRIGGER "email_outbox_dispatch_binding_guard"
BEFORE INSERT OR UPDATE ON public.email_outbox
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_email_outbox_dispatch_binding"();--> statement-breakpoint
REVOKE ALL (
  dispatch_binding_version,
  dispatch_binding_sha256
) ON TABLE public.email_outbox
  FROM PUBLIC, learncoding_app, learncoding_worker, learncoding_migrator,
       learncoding_ops;--> statement-breakpoint
GRANT UPDATE (
  dispatch_binding_version,
  dispatch_binding_sha256
) ON TABLE public.email_outbox TO learncoding_worker;
