CREATE TABLE "public"."backup_status_mail_authority" (
  "id" uuid PRIMARY KEY,
  "run_key" text NOT NULL UNIQUE,
  "outcome" text NOT NULL,
  "recipient_user_id" text NOT NULL,
  "recipient_email" text NOT NULL,
  "outbox_id" uuid NOT NULL UNIQUE,
  "operation_id" uuid NOT NULL UNIQUE,
  "created_at" timestamp with time zone
    DEFAULT pg_catalog.statement_timestamp() NOT NULL,
  CONSTRAINT "backup_status_mail_authority_run_key_valid"
    CHECK ("run_key" ~ '^[0-9]{8}T[0-9]{6}Z$'),
  CONSTRAINT "backup_status_mail_authority_outcome_valid"
    CHECK ("outcome" IN ('success', 'failure')),
  CONSTRAINT "backup_status_mail_authority_recipient_email_canonical"
    CHECK (
      "recipient_email" = pg_catalog.lower(pg_catalog.btrim("recipient_email"))
      AND "recipient_email" <> ''
    )
);--> statement-breakpoint
ALTER TABLE "public"."backup_status_mail_authority"
  OWNER TO learncoding_owner;--> statement-breakpoint
REVOKE ALL ON TABLE "public"."backup_status_mail_authority"
  FROM PUBLIC, learncoding_app, learncoding_worker, learncoding_migrator,
       learncoding_ops, learncoding_backup_reporter;--> statement-breakpoint
CREATE FUNCTION "public"."reject_backup_status_mail_authority_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'backup status mail authority is immutable'
    USING ERRCODE = '23514';
END
$function$;--> statement-breakpoint
ALTER FUNCTION "public"."reject_backup_status_mail_authority_mutation"()
  OWNER TO learncoding_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."reject_backup_status_mail_authority_mutation"()
  FROM PUBLIC, learncoding_app, learncoding_worker, learncoding_migrator,
       learncoding_ops, learncoding_backup_reporter;--> statement-breakpoint
CREATE TRIGGER "backup_status_mail_authority_immutable"
BEFORE UPDATE OR DELETE ON "public"."backup_status_mail_authority"
FOR EACH ROW
EXECUTE FUNCTION "public"."reject_backup_status_mail_authority_mutation"();--> statement-breakpoint
CREATE TRIGGER "backup_status_mail_authority_no_truncate"
BEFORE TRUNCATE ON "public"."backup_status_mail_authority"
FOR EACH STATEMENT
EXECUTE FUNCTION "public"."reject_backup_status_mail_authority_mutation"();--> statement-breakpoint

CREATE FUNCTION "public"."enqueue_backup_status_mail_authority"(
  "run_key" text,
  "outcome" text
)
RETURNS TABLE(
  "acknowledgement" text,
  "authority_id" uuid,
  "outbox_id" uuid,
  "operation_id" uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  requested_outcome text := "outcome";
  selected_admin_count integer;
  selected_admin_id text;
  selected_admin_email text;
  new_authority_id uuid;
  new_outbox_id uuid;
  new_operation_id uuid;
  existing_source public.backup_status_mail_authority%ROWTYPE;
  replay_authorized boolean := false;
  fixed_summary text;
BEGIN
  IF session_user <> 'learncoding_backup_reporter'
     OR current_user <> 'learncoding_owner' THEN
    RAISE EXCEPTION 'backup status mail reporter is not authorized'
      USING ERRCODE = '42501';
  END IF;
  IF "run_key" IS NULL
     OR "run_key" !~ '^[0-9]{8}T[0-9]{6}Z$' THEN
    RAISE EXCEPTION 'backup status mail run key is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF requested_outcome IS NULL
     OR requested_outcome NOT IN ('success', 'failure') THEN
    RAISE EXCEPTION 'backup status mail outcome is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'backup-status-authority:' || "run_key",
      0
    )
  );

  LOCK TABLE public."user" IN SHARE MODE;

  SELECT source.*
    INTO existing_source
    FROM public.backup_status_mail_authority AS source
   WHERE source.run_key = "run_key";

  IF FOUND THEN
    SELECT TRUE
      INTO replay_authorized
      FROM public.backup_status_mail_authority AS source
      JOIN public.email_outbox AS candidate
        ON candidate.id = source.outbox_id
      JOIN public."user" AS admin_recipient
        ON admin_recipient.id = source.recipient_user_id
     WHERE source.id = existing_source.id
       AND source.run_key = "run_key"
       AND source.outcome = requested_outcome
       AND source.outbox_id = candidate.id
       AND source.operation_id = candidate.operation_id
       AND source.recipient_user_id = admin_recipient.id
       AND source.recipient_email = candidate.to_email
       AND candidate.user_id = source.recipient_user_id
       AND candidate.delivery_scope_key =
         'a:' || source.recipient_user_id
       AND candidate.template = 'backup-status'
       AND candidate.template_version = '1'
       AND candidate.idempotency_key =
         'backup-status:v1:' || source.run_key
       AND candidate.variables = pg_catalog.jsonb_build_object(
         'name', 'Administrator',
         'summary', CASE source.outcome
           WHEN 'success' THEN
             'The nightly encrypted backup completed and passed local verification. No archive is attached to this email.'
           WHEN 'failure' THEN
             'The nightly encrypted backup did not complete. Review the protected operations logs; no archive or log is attached to this email.'
         END
       )
       AND admin_recipient.role = 'admin'
       AND admin_recipient.status = 'active'
       AND pg_catalog.coalesce(admin_recipient.banned, false) = false
       AND pg_catalog.lower(pg_catalog.btrim(admin_recipient.email)) =
         candidate.to_email
       AND (
         SELECT pg_catalog.count(*) = 1
           FROM public."user" AS sole_admin
          WHERE sole_admin.role = 'admin'
            AND sole_admin.status = 'active'
            AND pg_catalog.coalesce(sole_admin.banned, false) = false
       )
     FOR SHARE OF source, candidate, admin_recipient;

    IF replay_authorized IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'backup status mail replay conflicts with durable authority'
        USING ERRCODE = '23514';
    END IF;

    RETURN QUERY
    SELECT
      'existing'::text,
      existing_source.id,
      existing_source.outbox_id,
      existing_source.operation_id;
    RETURN;
  END IF;

  SELECT pg_catalog.count(*)
    INTO selected_admin_count
    FROM public."user" AS admin_recipient
   WHERE admin_recipient.role = 'admin'
     AND admin_recipient.status = 'active'
     AND pg_catalog.coalesce(admin_recipient.banned, false) = false;
  IF selected_admin_count <> 1 THEN
    RAISE EXCEPTION 'backup status mail requires exactly one active administrator'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    admin_recipient.id,
    pg_catalog.lower(pg_catalog.btrim(admin_recipient.email))
    INTO selected_admin_id, selected_admin_email
    FROM public."user" AS admin_recipient
   WHERE admin_recipient.role = 'admin'
     AND admin_recipient.status = 'active'
     AND pg_catalog.coalesce(admin_recipient.banned, false) = false
   FOR SHARE OF admin_recipient;
  IF selected_admin_email IS NULL OR selected_admin_email = '' THEN
    RAISE EXCEPTION 'backup status mail administrator email is invalid'
      USING ERRCODE = '23514';
  END IF;

  new_authority_id := pg_catalog.gen_random_uuid();
  new_outbox_id := pg_catalog.gen_random_uuid();
  new_operation_id := pg_catalog.gen_random_uuid();
  fixed_summary := CASE requested_outcome
    WHEN 'success' THEN
      'The nightly encrypted backup completed and passed local verification. No archive is attached to this email.'
    WHEN 'failure' THEN
      'The nightly encrypted backup did not complete. Review the protected operations logs; no archive or log is attached to this email.'
  END;

  INSERT INTO public.backup_status_mail_authority (
    id,
    run_key,
    outcome,
    recipient_user_id,
    recipient_email,
    outbox_id,
    operation_id
  ) VALUES (
    new_authority_id,
    "run_key",
    requested_outcome,
    selected_admin_id,
    selected_admin_email,
    new_outbox_id,
    new_operation_id
  );

  INSERT INTO public.email_outbox (
    id,
    operation_id,
    user_id,
    delivery_scope_key,
    to_email,
    template,
    template_version,
    variables,
    idempotency_key
  ) VALUES (
    new_outbox_id,
    new_operation_id,
    selected_admin_id,
    'a:' || selected_admin_id,
    selected_admin_email,
    'backup-status',
    '1',
    pg_catalog.jsonb_build_object(
      'name', 'Administrator',
      'summary', fixed_summary
    ),
    'backup-status:v1:' || "run_key"
  );

  RETURN QUERY
  SELECT
    'queued'::text,
    new_authority_id,
    new_outbox_id,
    new_operation_id;
END
$function$;--> statement-breakpoint
ALTER FUNCTION "public"."enqueue_backup_status_mail_authority"(text, text)
  OWNER TO learncoding_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."enqueue_backup_status_mail_authority"(text, text)
  FROM PUBLIC, learncoding_app, learncoding_worker, learncoding_migrator,
       learncoding_ops, learncoding_backup_reporter;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  "public"."enqueue_backup_status_mail_authority"(text, text)
  TO learncoding_backup_reporter;--> statement-breakpoint

CREATE FUNCTION "public"."backup_status_mail_authorized"(
  "candidate_outbox_id" uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  authorized boolean := false;
BEGIN
  IF session_user <> 'learncoding_worker'
     OR current_user <> 'learncoding_owner' THEN
    RAISE EXCEPTION 'backup status mail predicate caller is not authorized'
      USING ERRCODE = '42501';
  END IF;
  IF candidate_outbox_id IS NULL THEN
    RETURN false;
  END IF;

  LOCK TABLE public."user" IN SHARE MODE;

  SELECT TRUE
    INTO authorized
    FROM public.backup_status_mail_authority AS source
    JOIN public.email_outbox AS candidate
      ON candidate.id = source.outbox_id
    JOIN public."user" AS admin_recipient
      ON admin_recipient.id = source.recipient_user_id
   WHERE candidate.id = candidate_outbox_id
     AND source.outbox_id = candidate.id
     AND source.operation_id = candidate.operation_id
     AND source.recipient_user_id = admin_recipient.id
     AND source.recipient_email = candidate.to_email
     AND candidate.user_id = source.recipient_user_id
     AND candidate.delivery_scope_key =
       'a:' || source.recipient_user_id
     AND candidate.template = 'backup-status'
     AND candidate.template_version = '1'
     AND candidate.idempotency_key =
       'backup-status:v1:' || source.run_key
     AND candidate.variables = pg_catalog.jsonb_build_object(
       'name', 'Administrator',
       'summary', CASE source.outcome
         WHEN 'success' THEN
           'The nightly encrypted backup completed and passed local verification. No archive is attached to this email.'
         WHEN 'failure' THEN
           'The nightly encrypted backup did not complete. Review the protected operations logs; no archive or log is attached to this email.'
       END
     )
     AND admin_recipient.role = 'admin'
     AND admin_recipient.status = 'active'
     AND pg_catalog.coalesce(admin_recipient.banned, false) = false
     AND pg_catalog.lower(pg_catalog.btrim(admin_recipient.email)) =
       candidate.to_email
     AND (
       SELECT pg_catalog.count(*) = 1
         FROM public."user" AS sole_admin
        WHERE sole_admin.role = 'admin'
          AND sole_admin.status = 'active'
          AND pg_catalog.coalesce(sole_admin.banned, false) = false
     )
   FOR SHARE OF source, candidate, admin_recipient;

  RETURN pg_catalog.coalesce(authorized, false);
END
$function$;--> statement-breakpoint
ALTER FUNCTION "public"."backup_status_mail_authorized"(uuid)
  OWNER TO learncoding_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."backup_status_mail_authorized"(uuid)
  FROM PUBLIC, learncoding_app, learncoding_worker, learncoding_migrator,
       learncoding_ops, learncoding_backup_reporter;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."backup_status_mail_authorized"(uuid)
  TO learncoding_worker;
