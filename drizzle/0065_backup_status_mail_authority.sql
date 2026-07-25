CREATE TABLE "public"."backup_status_mail_authority" (
  "id" uuid PRIMARY KEY,
  "run_key" text NOT NULL UNIQUE,
  "outcome" text NOT NULL,
  "outbox_id" uuid NOT NULL UNIQUE,
  "operation_id" uuid NOT NULL UNIQUE,
  "authority_epoch" uuid NOT NULL,
  "created_at" timestamp with time zone
    DEFAULT pg_catalog.statement_timestamp() NOT NULL,
  CONSTRAINT "backup_status_mail_authority_run_key_valid"
    CHECK ("run_key" ~ '^[0-9]{8}T[0-9]{6}Z$'),
  CONSTRAINT "backup_status_mail_authority_outcome_valid"
    CHECK ("outcome" IN ('success', 'failure')),
  CONSTRAINT "backup_status_mail_authority_epoch_valid"
    CHECK (
      "authority_epoch" <> '00000000-0000-0000-0000-000000000000'::uuid
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

CREATE TABLE "public"."backup_status_mail_admin_guard" (
  "singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
  "authority_epoch" uuid
    DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
  CONSTRAINT "backup_status_mail_admin_guard_singleton"
    CHECK ("singleton" IS TRUE),
  CONSTRAINT "backup_status_mail_admin_guard_epoch_valid"
    CHECK (
      "authority_epoch" <> '00000000-0000-0000-0000-000000000000'::uuid
    )
);--> statement-breakpoint
ALTER TABLE "public"."backup_status_mail_admin_guard"
  OWNER TO learncoding_owner;--> statement-breakpoint
INSERT INTO "public"."backup_status_mail_admin_guard" ("singleton")
VALUES (true);--> statement-breakpoint
REVOKE ALL ON TABLE "public"."backup_status_mail_admin_guard"
  FROM PUBLIC, learncoding_app, learncoding_worker, learncoding_migrator,
       learncoding_ops, learncoding_backup_reporter;--> statement-breakpoint

CREATE FUNCTION "public"."lock_backup_status_mail_admin_authority"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  authority_change boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    authority_change :=
      NEW.role = 'admin'
      AND NEW.status = 'active'
      AND coalesce(NEW.banned, false) = false;
  ELSIF TG_OP = 'DELETE' THEN
    authority_change :=
      OLD.role = 'admin'
      AND OLD.status = 'active'
      AND coalesce(OLD.banned, false) = false;
  ELSE
    authority_change := (
      OLD.role = 'admin'
      AND OLD.status = 'active'
      AND coalesce(OLD.banned, false) = false
    ) OR (
      NEW.role = 'admin'
      AND NEW.status = 'active'
      AND coalesce(NEW.banned, false) = false
    );
  END IF;

  IF authority_change THEN
    UPDATE public.backup_status_mail_admin_guard
       SET authority_epoch = pg_catalog.gen_random_uuid()
     WHERE singleton IS TRUE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'backup status administrator authority guard is missing'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$function$;--> statement-breakpoint
ALTER FUNCTION "public"."lock_backup_status_mail_admin_authority"()
  OWNER TO learncoding_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."lock_backup_status_mail_admin_authority"()
  FROM PUBLIC, learncoding_app, learncoding_worker, learncoding_migrator,
       learncoding_ops, learncoding_backup_reporter;--> statement-breakpoint
CREATE TRIGGER "backup_status_mail_admin_insert_lock"
BEFORE INSERT ON "public"."user"
FOR EACH ROW
EXECUTE FUNCTION "public"."lock_backup_status_mail_admin_authority"();--> statement-breakpoint
CREATE TRIGGER "backup_status_mail_admin_update_lock"
BEFORE UPDATE OF email, role, status, banned ON "public"."user"
FOR EACH ROW
EXECUTE FUNCTION "public"."lock_backup_status_mail_admin_authority"();--> statement-breakpoint
CREATE TRIGGER "backup_status_mail_admin_delete_lock"
BEFORE DELETE ON "public"."user"
FOR EACH ROW
EXECUTE FUNCTION "public"."lock_backup_status_mail_admin_authority"();--> statement-breakpoint

CREATE FUNCTION "public"."enqueue_backup_status_mail_authority"(
  "p_run_key" text,
  "p_outcome" text
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
  requested_outcome text := p_outcome;
  selected_admin_count integer;
  revalidated_admin_count integer;
  selected_admin_id text;
  selected_admin_email text;
  selected_authority_epoch uuid;
  current_authority_epoch uuid;
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
  IF p_run_key IS NULL
     OR p_run_key !~ '^[0-9]{8}T[0-9]{6}Z$' THEN
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
      'backup-status-authority:' || p_run_key,
      0
    )
  );

  SELECT source.*
    INTO existing_source
    FROM public.backup_status_mail_authority AS source
   WHERE source.run_key = p_run_key;

  IF FOUND THEN
    SELECT candidate.user_id
      INTO selected_admin_id
      FROM public.email_outbox AS candidate
     WHERE candidate.id = existing_source.outbox_id
       AND candidate.operation_id = existing_source.operation_id;
    IF NOT FOUND OR selected_admin_id IS NULL THEN
      RAISE EXCEPTION 'backup status mail replay conflicts with durable authority'
        USING ERRCODE = '23514';
    END IF;

    PERFORM locked_recipient.id
      FROM public."user" AS locked_recipient
     WHERE locked_recipient.id = selected_admin_id
     FOR SHARE OF locked_recipient;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'backup status mail replay conflicts with durable authority'
        USING ERRCODE = '23514';
    END IF;

    PERFORM locked_candidate.id
      FROM public.email_outbox AS locked_candidate
     WHERE locked_candidate.id = existing_source.outbox_id
       AND locked_candidate.operation_id = existing_source.operation_id
       AND locked_candidate.user_id = selected_admin_id
     FOR SHARE OF locked_candidate;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'backup status mail replay conflicts with durable authority'
        USING ERRCODE = '23514';
    END IF;

    PERFORM locked_source.id
      FROM public.backup_status_mail_authority AS locked_source
     WHERE locked_source.id = existing_source.id
       AND locked_source.outbox_id = existing_source.outbox_id
       AND locked_source.operation_id = existing_source.operation_id
     FOR SHARE OF locked_source;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'backup status mail replay conflicts with durable authority'
        USING ERRCODE = '23514';
    END IF;

    SELECT authority_guard.authority_epoch
      INTO current_authority_epoch
      FROM public.backup_status_mail_admin_guard AS authority_guard
     WHERE authority_guard.singleton IS TRUE
     FOR SHARE OF authority_guard;
    IF NOT FOUND OR current_authority_epoch IS NULL THEN
      RAISE EXCEPTION 'backup status administrator authority guard is missing'
        USING ERRCODE = '23514';
    END IF;

    SELECT TRUE
      INTO replay_authorized
      FROM public.backup_status_mail_authority AS source
      JOIN public.email_outbox AS candidate
        ON candidate.id = source.outbox_id
      JOIN public."user" AS admin_recipient
        ON admin_recipient.id = candidate.user_id
     WHERE source.id = existing_source.id
       AND source.run_key = p_run_key
       AND source.outcome = requested_outcome
       AND source.outbox_id = candidate.id
       AND source.operation_id = candidate.operation_id
       AND source.authority_epoch = current_authority_epoch
       AND candidate.user_id = admin_recipient.id
       AND candidate.delivery_scope_key =
         'a:' || candidate.user_id
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
       AND coalesce(admin_recipient.banned, false) = false
       AND pg_catalog.lower(pg_catalog.btrim(admin_recipient.email)) =
         candidate.to_email
       AND (
         SELECT pg_catalog.count(*) = 1
           FROM public."user" AS sole_admin
          WHERE sole_admin.role = 'admin'
            AND sole_admin.status = 'active'
            AND coalesce(sole_admin.banned, false) = false
       );

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
     AND coalesce(admin_recipient.banned, false) = false;
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
     AND coalesce(admin_recipient.banned, false) = false
   FOR SHARE OF admin_recipient;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'backup status mail administrator changed during selection'
      USING ERRCODE = '23514';
  END IF;

  SELECT authority_guard.authority_epoch
    INTO selected_authority_epoch
    FROM public.backup_status_mail_admin_guard AS authority_guard
   WHERE authority_guard.singleton IS TRUE
   FOR SHARE OF authority_guard;
  IF NOT FOUND OR selected_authority_epoch IS NULL THEN
    RAISE EXCEPTION 'backup status administrator authority guard is missing'
      USING ERRCODE = '23514';
  END IF;

  SELECT pg_catalog.count(*)
    INTO revalidated_admin_count
    FROM public."user" AS revalidated_admin
   WHERE revalidated_admin.role = 'admin'
     AND revalidated_admin.status = 'active'
     AND coalesce(revalidated_admin.banned, false) = false;
  IF revalidated_admin_count <> 1 THEN
    RAISE EXCEPTION 'backup status mail administrator changed during selection'
      USING ERRCODE = '23514';
  END IF;
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
    outbox_id,
    operation_id,
    authority_epoch
  ) VALUES (
    new_authority_id,
    p_run_key,
    requested_outcome,
    new_outbox_id,
    new_operation_id,
    selected_authority_epoch
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
    'backup-status:v1:' || p_run_key
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
  "p_candidate_outbox_id" uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  authorized boolean := false;
  selected_admin_id text;
  selected_operation_id uuid;
  current_authority_epoch uuid;
BEGIN
  IF session_user <> 'learncoding_worker'
     OR current_user <> 'learncoding_owner' THEN
    RAISE EXCEPTION 'backup status mail predicate caller is not authorized'
      USING ERRCODE = '42501';
  END IF;
  IF p_candidate_outbox_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT candidate.user_id, candidate.operation_id
    INTO selected_admin_id, selected_operation_id
    FROM public.backup_status_mail_authority AS source
    JOIN public.email_outbox AS candidate
      ON candidate.id = source.outbox_id
   WHERE candidate.id = p_candidate_outbox_id
     AND source.outbox_id = candidate.id
     AND source.operation_id = candidate.operation_id;
  IF NOT FOUND OR selected_admin_id IS NULL THEN
    RETURN false;
  END IF;

  PERFORM locked_recipient.id
    FROM public."user" AS locked_recipient
   WHERE locked_recipient.id = selected_admin_id
   FOR SHARE OF locked_recipient;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM locked_candidate.id
    FROM public.email_outbox AS locked_candidate
   WHERE locked_candidate.id = p_candidate_outbox_id
     AND locked_candidate.operation_id = selected_operation_id
     AND locked_candidate.user_id = selected_admin_id
   FOR SHARE OF locked_candidate;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM locked_source.id
    FROM public.backup_status_mail_authority AS locked_source
   WHERE locked_source.outbox_id = p_candidate_outbox_id
     AND locked_source.operation_id = selected_operation_id
   FOR SHARE OF locked_source;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  SELECT authority_guard.authority_epoch
    INTO current_authority_epoch
    FROM public.backup_status_mail_admin_guard AS authority_guard
   WHERE authority_guard.singleton IS TRUE
   FOR SHARE OF authority_guard;
  IF NOT FOUND OR current_authority_epoch IS NULL THEN
    RAISE EXCEPTION 'backup status administrator authority guard is missing'
      USING ERRCODE = '23514';
  END IF;

  SELECT TRUE
    INTO authorized
    FROM public.backup_status_mail_authority AS source
    JOIN public.email_outbox AS candidate
      ON candidate.id = source.outbox_id
    JOIN public."user" AS admin_recipient
      ON admin_recipient.id = candidate.user_id
   WHERE candidate.id = p_candidate_outbox_id
     AND source.outbox_id = candidate.id
     AND source.operation_id = candidate.operation_id
     AND source.authority_epoch = current_authority_epoch
     AND candidate.user_id = admin_recipient.id
     AND candidate.delivery_scope_key =
       'a:' || candidate.user_id
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
     AND coalesce(admin_recipient.banned, false) = false
     AND pg_catalog.lower(pg_catalog.btrim(admin_recipient.email)) =
       candidate.to_email
     AND (
       SELECT pg_catalog.count(*) = 1
         FROM public."user" AS sole_admin
        WHERE sole_admin.role = 'admin'
          AND sole_admin.status = 'active'
          AND coalesce(sole_admin.banned, false) = false
     );

  RETURN coalesce(authorized, false);
END
$function$;--> statement-breakpoint
ALTER FUNCTION "public"."backup_status_mail_authorized"(uuid)
  OWNER TO learncoding_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."backup_status_mail_authorized"(uuid)
  FROM PUBLIC, learncoding_app, learncoding_worker, learncoding_migrator,
       learncoding_ops, learncoding_backup_reporter;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."backup_status_mail_authorized"(uuid)
  TO learncoding_worker;
