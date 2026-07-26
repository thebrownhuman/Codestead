-- Durable mail replay authority.
-- Writers are drained before this ACCESS EXCLUSIVE cutover is applied.
LOCK TABLE
  public.email_outbox,
  public.backup_status_mail_authority
IN ACCESS EXCLUSIVE MODE NOWAIT;--> statement-breakpoint
-- Alias proof sources are locked atomically in this reviewed producer order.
LOCK TABLE
  public."user",
  public.verification,
  public.lost_device_proof,
  public.session_revocation_request,
  public.inactivity_episode,
  public.smart_reminder_dispatch,
  public.access_request,
  public.invitation
IN SHARE MODE NOWAIT;--> statement-breakpoint
SET LOCAL search_path = pg_catalog, pg_temp;--> statement-breakpoint

DO $codestead_delivery_hold_quiescence$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.email_outbox
     WHERE status = 'sending'
        OR claim_token IS NOT NULL
        OR claim_owner IS NOT NULL
        OR (
          lease_expires_at IS NOT NULL
          AND lease_expires_at >= pg_catalog.statement_timestamp()
        )
  ) THEN
    RAISE EXCEPTION
      'email outbox delivery cutover requires quiescence'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_delivery_hold_valid';
  END IF;
END
$codestead_delivery_hold_quiescence$;--> statement-breakpoint

ALTER TABLE public.backup_status_mail_authority
  ADD CONSTRAINT backup_status_mail_authority_run_key_uuid_v4_valid
  CHECK (
    run_key ~ '^[0-9]{8}T[0-9]{6}Z$'
    OR run_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) NOT VALID;--> statement-breakpoint
ALTER TABLE public.backup_status_mail_authority
  VALIDATE CONSTRAINT backup_status_mail_authority_run_key_uuid_v4_valid;--> statement-breakpoint
ALTER TABLE public.backup_status_mail_authority
  DROP CONSTRAINT backup_status_mail_authority_run_key_valid;--> statement-breakpoint
ALTER TABLE public.backup_status_mail_authority
  RENAME CONSTRAINT backup_status_mail_authority_run_key_uuid_v4_valid
  TO backup_status_mail_authority_run_key_valid;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."enqueue_backup_status_mail_authority"(
  "p_run_key" pg_catalog.text,
  "p_outcome" pg_catalog.text
)
RETURNS TABLE(
  "acknowledgement" pg_catalog.text,
  "authority_id" pg_catalog.uuid,
  "outbox_id" pg_catalog.uuid,
  "operation_id" pg_catalog.uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  requested_outcome pg_catalog.text := p_outcome;
  selected_admin_count pg_catalog.integer;
  revalidated_admin_count pg_catalog.integer;
  hinted_admin_id pg_catalog.text;
  selected_admin_id pg_catalog.text;
  selected_admin_email pg_catalog.text;
  selected_authority_epoch pg_catalog.uuid;
  current_authority_epoch pg_catalog.uuid;
  new_authority_id pg_catalog.uuid;
  new_outbox_id pg_catalog.uuid;
  new_operation_id pg_catalog.uuid;
  existing_source public.backup_status_mail_authority%ROWTYPE;
  replay_authorized pg_catalog.boolean := false;
  fixed_summary pg_catalog.text;
BEGIN
  IF session_user <> 'learncoding_backup_reporter'
     OR current_user <> 'learncoding_owner' THEN
    RAISE EXCEPTION 'backup status mail reporter is not authorized'
      USING ERRCODE = '42501';
  END IF;
  IF p_run_key IS NULL
     OR (
       p_run_key !~ '^[0-9]{8}T[0-9]{6}Z$'
       AND p_run_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     ) THEN
    RAISE EXCEPTION 'backup status mail run key is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF requested_outcome IS NULL
     OR requested_outcome NOT IN ('success', 'failure') THEN
    RAISE EXCEPTION 'backup status mail outcome is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT candidate.user_id
    INTO hinted_admin_id
    FROM public.backup_status_mail_authority AS source
    JOIN public.email_outbox AS candidate
      ON candidate.id = source.outbox_id
   WHERE source.run_key = p_run_key
     AND source.outbox_id = candidate.id
     AND source.operation_id = candidate.operation_id;

  IF FOUND AND hinted_admin_id IS NULL THEN
    RAISE EXCEPTION
      'backup status mail replay conflicts with durable authority'
      USING ERRCODE = '23514';
  END IF;

  IF NOT FOUND THEN
    SELECT pg_catalog.count(*), pg_catalog.min(admin_recipient.id)
      INTO selected_admin_count, hinted_admin_id
      FROM public."user" AS admin_recipient
     WHERE admin_recipient.role = 'admin'
       AND admin_recipient.status = 'active'
       AND coalesce(admin_recipient.banned, false) = false;
    IF selected_admin_count <> 1 OR hinted_admin_id IS NULL THEN
      RAISE EXCEPTION
        'backup status mail requires exactly one active administrator'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(
      'user-authority:' || hinted_admin_id
    )::pg_catalog.int8
  );

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
    IF selected_admin_id IS DISTINCT FROM hinted_admin_id THEN
      RAISE EXCEPTION 'backup status mail replay conflicts with durable authority'
        USING ERRCODE = '23514';
    END IF;

    PERFORM locked_recipient.id
      FROM public."user" AS locked_recipient
     WHERE locked_recipient.id = hinted_admin_id
     FOR SHARE OF locked_recipient;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'backup status mail replay conflicts with durable authority'
        USING ERRCODE = '23514';
    END IF;

    PERFORM locked_candidate.id
      FROM public.email_outbox AS locked_candidate
     WHERE locked_candidate.id = existing_source.outbox_id
       AND locked_candidate.operation_id = existing_source.operation_id
       AND locked_candidate.user_id = hinted_admin_id
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
       AND candidate.user_id = hinted_admin_id
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
      'existing'::pg_catalog.text,
      existing_source.id,
      existing_source.outbox_id,
      existing_source.operation_id;
    RETURN;
  END IF;

  SELECT
    admin_recipient.id,
    pg_catalog.lower(pg_catalog.btrim(admin_recipient.email))
    INTO selected_admin_id, selected_admin_email
    FROM public."user" AS admin_recipient
   WHERE admin_recipient.id = hinted_admin_id
     AND admin_recipient.role = 'admin'
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
   WHERE authority_guard.singleton IS TRUE;
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
    hinted_admin_id,
    'a:' || hinted_admin_id,
    selected_admin_email,
    'backup-status',
    '1',
    pg_catalog.jsonb_build_object(
      'name', 'Administrator',
      'summary', fixed_summary
    ),
    'backup-status:v1:' || p_run_key
  );

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

  PERFORM locked_candidate.id
    FROM public.email_outbox AS locked_candidate
   WHERE locked_candidate.id = new_outbox_id
     AND locked_candidate.operation_id = new_operation_id
     AND locked_candidate.user_id = hinted_admin_id
   FOR SHARE OF locked_candidate;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'backup status mail authority changed during creation'
      USING ERRCODE = '23514';
  END IF;

  PERFORM locked_source.id
    FROM public.backup_status_mail_authority AS locked_source
   WHERE locked_source.id = new_authority_id
     AND locked_source.run_key = p_run_key
     AND locked_source.outbox_id = new_outbox_id
     AND locked_source.operation_id = new_operation_id
   FOR SHARE OF locked_source;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'backup status mail authority changed during creation'
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
  IF current_authority_epoch IS DISTINCT FROM selected_authority_epoch THEN
    RAISE EXCEPTION
      'backup status mail authority changed during creation'
      USING ERRCODE = '23514';
  END IF;

  SELECT TRUE
    INTO replay_authorized
    FROM public.backup_status_mail_authority AS source
    JOIN public.email_outbox AS candidate
      ON candidate.id = source.outbox_id
    JOIN public."user" AS admin_recipient
      ON admin_recipient.id = candidate.user_id
   WHERE source.id = new_authority_id
     AND source.run_key = p_run_key
     AND source.outcome = requested_outcome
     AND source.outbox_id = new_outbox_id
     AND source.operation_id = new_operation_id
     AND source.authority_epoch = current_authority_epoch
     AND candidate.operation_id = new_operation_id
     AND candidate.user_id = hinted_admin_id
     AND candidate.delivery_scope_key =
       'a:' || candidate.user_id
     AND candidate.to_email = selected_admin_email
     AND candidate.template = 'backup-status'
     AND candidate.template_version = '1'
     AND candidate.idempotency_key =
       'backup-status:v1:' || source.run_key
     AND candidate.variables = pg_catalog.jsonb_build_object(
       'name', 'Administrator',
       'summary', fixed_summary
     )
     AND admin_recipient.id = hinted_admin_id
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
    RAISE EXCEPTION
      'backup status mail authority changed during creation'
      USING ERRCODE = '23514';
  END IF;

  RETURN QUERY
  SELECT
    'queued'::pg_catalog.text,
    new_authority_id,
    new_outbox_id,
    new_operation_id;
END
$function$;--> statement-breakpoint
ALTER FUNCTION "public"."enqueue_backup_status_mail_authority"(pg_catalog.text, pg_catalog.text)
  OWNER TO learncoding_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."enqueue_backup_status_mail_authority"(pg_catalog.text, pg_catalog.text)
  FROM PUBLIC, learncoding_app, learncoding_worker, learncoding_migrator,
       learncoding_ops, learncoding_backup_reporter;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  "public"."enqueue_backup_status_mail_authority"(pg_catalog.text, pg_catalog.text)
  TO learncoding_backup_reporter;--> statement-breakpoint

CREATE FUNCTION pg_temp.mail_outbox_historical_ascii_email_matches(
  source_email pg_catalog.text,
  outbox_email pg_catalog.text
)
RETURNS pg_catalog.boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT (
    source_email IS NOT NULL
    AND outbox_email IS NOT NULL
    AND pg_catalog.encode(
      pg_catalog.convert_to(pg_catalog.btrim(source_email), 'UTF8'),
      'hex'
    ) ~ '^([0-7][0-9a-f])+$'
    AND pg_catalog.encode(
      pg_catalog.convert_to(outbox_email, 'UTF8'),
      'hex'
    ) ~ '^([0-7][0-9a-f])+$'
    AND pg_catalog.lower(
      pg_catalog.btrim(source_email) COLLATE "C"
    ) = outbox_email
    AND pg_catalog.lower(outbox_email COLLATE "C") = outbox_email
    AND pg_catalog.btrim(outbox_email) = outbox_email
  ) IS TRUE
$function$;--> statement-breakpoint
DO $block$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.email_outbox AS outbox
     WHERE pg_catalog.jsonb_typeof(outbox.variables)
       IS DISTINCT FROM 'object'
  ) THEN
    RAISE EXCEPTION
      'email outbox variables must be JSON objects at idempotency authority cutover'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.email_outbox AS outbox
     WHERE (
       pg_catalog.encode(
         pg_catalog.convert_to(outbox.to_email, 'UTF8'),
         'hex'
       ) !~ '^([0-7][0-9a-f])+$'
       OR pg_catalog.btrim(outbox.to_email) <> outbox.to_email
       OR pg_catalog.lower(outbox.to_email COLLATE "C") <> outbox.to_email
     ) IS NOT FALSE
  ) THEN
    RAISE EXCEPTION
      'email outbox recipient must be canonical ASCII at idempotency authority cutover'
      USING ERRCODE = '23514';
  END IF;
END
$block$;--> statement-breakpoint

CREATE FUNCTION public.email_outbox_original_payload_sha256(
  input_user_id pg_catalog.text,
  input_to_email pg_catalog.text,
  input_template pg_catalog.text,
  input_template_version pg_catalog.text,
  input_variables pg_catalog.jsonb
)
RETURNS pg_catalog.text
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_array(
          pg_catalog.to_jsonb('mail-replay-conflict-v1'::pg_catalog.text),
          pg_catalog.to_jsonb(input_template),
          pg_catalog.to_jsonb(
            CASE
              WHEN input_user_id IS NOT NULL
                THEN 'a:' || input_user_id
              ELSE
                's:' ||
                (input_variables ->> '_mailProducer') || ':' ||
                (input_variables ->> '_mailSourceId') || ':' ||
                (input_variables ->> '_mailAudienceId')
            END
          ),
          pg_catalog.to_jsonb(input_to_email),
          pg_catalog.to_jsonb(input_template_version),
          CASE
            WHEN pg_catalog.jsonb_typeof(input_variables) = 'object'
            THEN input_variables - ARRAY[
              '_mailOperationId',
              '_mailRecipient'
            ]
            ELSE input_variables
          END
        )::pg_catalog.text,
        'UTF8'
      )
    ),
    'hex'
  )
$function$;--> statement-breakpoint

CREATE FUNCTION public.email_outbox_event_sha256(
  input_template pg_catalog.text,
  input_scope pg_catalog.text,
  input_event_id pg_catalog.text
)
RETURNS pg_catalog.text
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        'mail-event-v1' || pg_catalog.chr(31) ||
        input_template || pg_catalog.chr(31) ||
        input_scope || pg_catalog.chr(31) ||
        input_event_id,
        'UTF8'
      )
    ),
    'hex'
  )
$function$;--> statement-breakpoint

ALTER FUNCTION public.email_outbox_original_payload_sha256(
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.jsonb
) OWNER TO learncoding_owner;--> statement-breakpoint
ALTER FUNCTION public.email_outbox_event_sha256(pg_catalog.text, pg_catalog.text, pg_catalog.text)
  OWNER TO learncoding_owner;--> statement-breakpoint

ALTER TABLE public.email_outbox
  ADD COLUMN idempotency_authority_version pg_catalog.text,
  ADD COLUMN idempotency_authority_sha256 pg_catalog.text,
  ADD COLUMN idempotency_original_payload_sha256 pg_catalog.text,
  ADD COLUMN delivery_hold_version pg_catalog.text;--> statement-breakpoint
UPDATE public.email_outbox
SET delivery_hold_version = 'task7-v1';--> statement-breakpoint
ALTER TABLE public.email_outbox
  ADD CONSTRAINT email_outbox_variables_object_valid
  CHECK ((pg_catalog.jsonb_typeof(variables) = 'object') IS TRUE) NOT VALID,
  ADD CONSTRAINT email_outbox_recipient_canonical_valid
  CHECK ((
      pg_catalog.encode(
        pg_catalog.convert_to(to_email, 'UTF8'),
        'hex'
      ) ~ '^([0-7][0-9a-f])+$'
      AND pg_catalog.btrim(to_email) = to_email
      AND pg_catalog.lower(to_email COLLATE "C") = to_email
    ) IS TRUE) NOT VALID;--> statement-breakpoint
ALTER TABLE public.email_outbox
  VALIDATE CONSTRAINT email_outbox_variables_object_valid;--> statement-breakpoint
ALTER TABLE public.email_outbox
  VALIDATE CONSTRAINT email_outbox_recipient_canonical_valid;--> statement-breakpoint

CREATE TABLE public.email_outbox_idempotency_authority (
  idempotency_sha256 pg_catalog.text PRIMARY KEY,
  original_payload_sha256 pg_catalog.text NOT NULL,
  CONSTRAINT email_outbox_idempotency_authority_digest_valid
    CHECK (idempotency_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT email_outbox_idempotency_authority_payload_valid
    CHECK (original_payload_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT email_outbox_idempotency_authority_payload_unique
    UNIQUE (idempotency_sha256, original_payload_sha256)
);--> statement-breakpoint
ALTER TABLE public.email_outbox_idempotency_authority
  OWNER TO learncoding_owner;--> statement-breakpoint

CREATE TEMP TABLE mail_outbox_replay_policy (
  template pg_catalog.text PRIMARY KEY,
  authority_version pg_catalog.text NOT NULL
    CHECK (authority_version IN (
      'event-v1-source-map',
      'legacy-key-source-one-shot-v1',
      'legacy-key-terminal-cas-v1',
      'legacy-key-protocol-retired-v1',
      'legacy-key-fresh-action-v1'
    ))
) ON COMMIT DROP;--> statement-breakpoint

INSERT INTO pg_temp.mail_outbox_replay_policy(template, authority_version)
VALUES
  ('reset-password', 'event-v1-source-map'),
  ('invitation', 'event-v1-source-map'),
  ('access-request-admin', 'legacy-key-source-one-shot-v1'),
  ('lost-device-proof', 'event-v1-source-map'),
  ('access-rejected', 'event-v1-source-map'),
  ('session-revocation-requested', 'event-v1-source-map'),
  ('account-deleted', 'event-v1-source-map'),
  ('inactivity-reminder', 'event-v1-source-map'),
  ('inactivity-reminder-followup', 'event-v1-source-map'),
  ('inactivity-admin-notice', 'event-v1-source-map'),
  ('daily-study-reminder', 'event-v1-source-map'),
  ('revision-reminder', 'event-v1-source-map'),
  ('goal-reminder', 'event-v1-source-map'),
  ('challenge-reminder', 'event-v1-source-map'),
  ('weekly-summary', 'event-v1-source-map'),
  ('backup-status', 'event-v1-source-map'),
  ('verify-email', 'event-v1-source-map'),
  ('learning-request-updated', 'legacy-key-terminal-cas-v1'),
  ('new-device', 'legacy-key-source-one-shot-v1'),
  ('session-revocation-updated', 'legacy-key-terminal-cas-v1'),
  ('session-revoked', 'legacy-key-source-one-shot-v1'),
  ('credential-changed', 'legacy-key-protocol-retired-v1'),
  ('credential-revealed', 'legacy-key-fresh-action-v1'),
  ('fallback-grant-changed', 'event-v1-source-map'),
  ('learning-plan-changed', 'event-v1-source-map'),
  ('storage-quota-changed', 'event-v1-source-map'),
  ('mastery-awarded', 'event-v1-source-map'),
  ('appeal-updated', 'event-v1-source-map'),
  ('assessment-corrected', 'event-v1-source-map');--> statement-breakpoint

DO $block$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM pg_temp.mail_outbox_replay_policy) <> 29
     OR (SELECT pg_catalog.count(DISTINCT template)
           FROM pg_temp.mail_outbox_replay_policy) <> 29
     OR (SELECT pg_catalog.count(*)
           FROM pg_temp.mail_outbox_replay_policy
          WHERE authority_version = 'event-v1-source-map') <> 22
     OR (SELECT pg_catalog.count(*)
           FROM pg_temp.mail_outbox_replay_policy
          WHERE authority_version = 'legacy-key-source-one-shot-v1') <> 3
     OR (SELECT pg_catalog.count(*)
           FROM pg_temp.mail_outbox_replay_policy
          WHERE authority_version = 'legacy-key-terminal-cas-v1') <> 2
     OR (SELECT pg_catalog.count(*)
           FROM pg_temp.mail_outbox_replay_policy
          WHERE authority_version = 'legacy-key-protocol-retired-v1') <> 1
     OR (SELECT pg_catalog.count(*)
           FROM pg_temp.mail_outbox_replay_policy
          WHERE authority_version = 'legacy-key-fresh-action-v1') <> 1
     OR EXISTS (
       SELECT 1
         FROM public.email_outbox AS outbox
         LEFT JOIN pg_temp.mail_outbox_replay_policy AS policy
           ON policy.template = outbox.template
        WHERE policy.template IS NULL
     )
  THEN
    RAISE EXCEPTION
      'unknown email outbox template at idempotency authority cutover'
      USING ERRCODE = '23514';
  END IF;
END
$block$;--> statement-breakpoint

UPDATE public.email_outbox
SET idempotency_authority_version = 'legacy-key-blocked-v1',
    idempotency_authority_sha256 = NULL,
    idempotency_original_payload_sha256 =
      public.email_outbox_original_payload_sha256(
        user_id,
        to_email,
        template,
        template_version,
        variables
      );--> statement-breakpoint

CREATE TEMP TABLE mail_outbox_proven_legacy_source_map (
  outbox_id pg_catalog.uuid PRIMARY KEY,
  idempotency_sha256 pg_catalog.text NOT NULL,
  original_payload_sha256 pg_catalog.text NOT NULL
) ON COMMIT DROP;--> statement-breakpoint

-- Twenty-one reviewed legacy source-map policy templates intentionally have no
-- promotion SQL. Their persisted rows do not authenticate every historical
-- origin, source, recipient, and immutable payload input. In particular,
-- storage-quota mail has no durable historical APP_URL origin and deletion
-- mail cannot recompute recipientHmacSha256 without the deletion HMAC secret.
-- Those rows remain legacy-key-blocked-v1; only backup-status below has a
-- complete, durable source/recipient/payload proof.

INSERT INTO pg_temp.mail_outbox_proven_legacy_source_map (
  outbox_id, idempotency_sha256, original_payload_sha256
)
SELECT
  outbox.id,
  public.email_outbox_event_sha256(
    outbox.template,
    'a:' || outbox.user_id,
    source.outcome || ':' || source.run_key
  ),
  outbox.idempotency_original_payload_sha256
FROM public.email_outbox AS outbox
JOIN public.backup_status_mail_authority AS source
  ON source.outbox_id = outbox.id
 AND source.operation_id = outbox.operation_id
JOIN public."user" AS recipient_user
  ON recipient_user.id = outbox.user_id
 AND recipient_user.role = 'admin'
 AND pg_temp.mail_outbox_historical_ascii_email_matches(
   recipient_user.email,
   outbox.to_email
 )
WHERE outbox.template = 'backup-status'
  AND outbox.template_version = '1'
  AND outbox.idempotency_key = 'backup-status:v1:' || source.run_key;--> statement-breakpoint

DO $block$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_temp.mail_outbox_proven_legacy_source_map AS alias
      JOIN public.email_outbox AS outbox ON outbox.id = alias.outbox_id
      LEFT JOIN pg_temp.mail_outbox_replay_policy AS policy
        ON policy.template = outbox.template
     WHERE policy.authority_version IS DISTINCT FROM 'event-v1-source-map'
  ) THEN
    RAISE EXCEPTION
      'email outbox generated legacy alias has unreviewed strategy'
      USING ERRCODE = '23514';
  END IF;
END
$block$;--> statement-breakpoint
DO $block$
BEGIN
  IF EXISTS (
    WITH authority_entry AS (
      SELECT
        pg_catalog.encode(
          pg_catalog.sha256(
            pg_catalog.convert_to(outbox.idempotency_key, 'UTF8')
          ),
          'hex'
        ) AS idempotency_sha256,
        outbox.idempotency_original_payload_sha256
          AS original_payload_sha256
      FROM public.email_outbox AS outbox
      UNION ALL
      SELECT alias.idempotency_sha256, alias.original_payload_sha256
      FROM pg_temp.mail_outbox_proven_legacy_source_map AS alias
    )
    SELECT 1
      FROM authority_entry
     GROUP BY idempotency_sha256
    HAVING pg_catalog.count(DISTINCT original_payload_sha256) > 1
  ) THEN
    RAISE EXCEPTION
      'email outbox legacy idempotency authority payload conflict'
      USING ERRCODE = '23505',
            CONSTRAINT = 'email_outbox_idempotency_authority_pkey';
  END IF;
END
$block$;--> statement-breakpoint

INSERT INTO public.email_outbox_idempotency_authority (
  idempotency_sha256,
  original_payload_sha256
)
SELECT DISTINCT
  pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(outbox.idempotency_key, 'UTF8')
    ),
    'hex'
  ),
  outbox.idempotency_original_payload_sha256
FROM public.email_outbox AS outbox
UNION
SELECT alias.idempotency_sha256, alias.original_payload_sha256
FROM pg_temp.mail_outbox_proven_legacy_source_map AS alias;--> statement-breakpoint

UPDATE public.email_outbox AS outbox
SET idempotency_authority_version = policy.authority_version
FROM pg_temp.mail_outbox_replay_policy AS policy
WHERE policy.template = outbox.template
  AND policy.authority_version <> 'event-v1-source-map';--> statement-breakpoint

UPDATE public.email_outbox AS outbox
SET idempotency_authority_version = 'event-v1-source-map',
    idempotency_authority_sha256 = source_map.idempotency_sha256,
    idempotency_original_payload_sha256 = source_map.original_payload_sha256
FROM pg_temp.mail_outbox_proven_legacy_source_map AS source_map
WHERE source_map.outbox_id = outbox.id;--> statement-breakpoint

ALTER TABLE public.email_outbox
  ALTER COLUMN idempotency_authority_version SET NOT NULL,
  ALTER COLUMN idempotency_original_payload_sha256 SET NOT NULL,
  ALTER COLUMN delivery_hold_version SET NOT NULL;--> statement-breakpoint
ALTER TABLE public.email_outbox
  ADD CONSTRAINT email_outbox_idempotency_authority_valid
  CHECK (
    (
      idempotency_original_payload_sha256 ~ '^[0-9a-f]{64}$'
      AND (
        (
          idempotency_authority_version IN (
            'event-v1-native',
            'event-v1-source-map'
          )
          AND idempotency_authority_sha256 ~ '^[0-9a-f]{64}$'
          AND (
            idempotency_authority_version <> 'event-v1-native'
            OR idempotency_authority_sha256 = idempotency_key
          )
        )
        OR (
          idempotency_authority_version IN (
            'legacy-key-source-one-shot-v1',
            'legacy-key-terminal-cas-v1',
            'legacy-key-protocol-retired-v1',
            'legacy-key-fresh-action-v1',
            'legacy-key-blocked-v1'
          )
          AND idempotency_authority_sha256 IS NULL
        )
      )
    ) IS TRUE
  ) NOT VALID,
  ADD CONSTRAINT email_outbox_delivery_hold_valid
  CHECK ((delivery_hold_version = 'task7-v1') IS TRUE) NOT VALID;--> statement-breakpoint
ALTER TABLE public.email_outbox
  VALIDATE CONSTRAINT email_outbox_idempotency_authority_valid;--> statement-breakpoint
ALTER TABLE public.email_outbox
  VALIDATE CONSTRAINT email_outbox_delivery_hold_valid;--> statement-breakpoint
ALTER TABLE public.email_outbox
  ADD CONSTRAINT email_outbox_idempotency_authority_fk
  FOREIGN KEY (
    idempotency_authority_sha256,
    idempotency_original_payload_sha256
  )
  REFERENCES public.email_outbox_idempotency_authority (
    idempotency_sha256,
    original_payload_sha256
  )
  ON UPDATE RESTRICT
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED
  NOT VALID;--> statement-breakpoint
ALTER TABLE public.email_outbox
  VALIDATE CONSTRAINT email_outbox_idempotency_authority_fk;--> statement-breakpoint
CREATE INDEX email_outbox_idempotency_authority_lookup_idx
  ON public.email_outbox USING btree (idempotency_authority_sha256, id)
  WHERE idempotency_authority_sha256 IS NOT NULL;--> statement-breakpoint

CREATE FUNCTION public.enforce_email_outbox_delivery_hold()
RETURNS pg_catalog.trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF OLD.delivery_hold_version = 'task7-v1'
     AND (
       NEW.idempotency_authority_version
         IS DISTINCT FROM OLD.idempotency_authority_version
       OR NEW.idempotency_authority_sha256
         IS DISTINCT FROM OLD.idempotency_authority_sha256
       OR NEW.idempotency_original_payload_sha256
         IS DISTINCT FROM OLD.idempotency_original_payload_sha256
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.attempt_count IS DISTINCT FROM OLD.attempt_count
       OR NEW.claim_token IS DISTINCT FROM OLD.claim_token
       OR NEW.claim_owner IS DISTINCT FROM OLD.claim_owner
       OR NEW.claim_version IS DISTINCT FROM OLD.claim_version
       OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
       OR NEW.provider_call_started IS DISTINCT FROM OLD.provider_call_started
       OR NEW.adapter IS DISTINCT FROM OLD.adapter
       OR NEW.dispatch_binding_version
         IS DISTINCT FROM OLD.dispatch_binding_version
       OR NEW.dispatch_binding_sha256
         IS DISTINCT FROM OLD.dispatch_binding_sha256
       OR NEW.provider_correlation_version
         IS DISTINCT FROM OLD.provider_correlation_version
       OR NEW.provider_evidence_version
         IS DISTINCT FROM OLD.provider_evidence_version
       OR NEW.provider_evidence_sha256
         IS DISTINCT FROM OLD.provider_evidence_sha256
       OR NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id
       OR NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at
       OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
       OR NEW.quarantined_at IS DISTINCT FROM OLD.quarantined_at
       OR NEW.last_error_code IS DISTINCT FROM OLD.last_error_code
       OR NEW.delivery_hold_version
         IS DISTINCT FROM OLD.delivery_hold_version
     )
  THEN
    RAISE EXCEPTION
      'email outbox delivery remains held for task7-v1'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_delivery_hold_valid';
  END IF;
  RETURN NEW;
END
$function$;--> statement-breakpoint

CREATE FUNCTION public.claim_email_outbox_idempotency_authority()
RETURNS pg_catalog.trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  prior_original_payload_sha256 pg_catalog.text;
  prior_lock_timeout pg_catalog.text;
  lock_timeout_was_clamped pg_catalog.bool := false;
  backup_run_key pg_catalog.text;
  backup_outcome pg_catalog.text;
  reserved_envelope_keys CONSTANT pg_catalog.text[] := ARRAY[
    '_mailOperationId',
    '_mailRecipient',
    '_mailProducer',
    '_mailSourceId',
    '_mailAudienceId'
  ]::pg_catalog.text[];
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') IS DISTINCT FROM
     'read committed'
  THEN
    RAISE EXCEPTION
      'email outbox replay authority requires read committed isolation'
      USING ERRCODE = '25001';
  END IF;

  IF NEW.delivery_hold_version IS NOT NULL THEN
    RAISE EXCEPTION 'email outbox delivery hold is database-owned'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_delivery_hold_valid';
  END IF;

  IF NEW.status IS DISTINCT FROM 'pending'
     OR NEW.attempt_count IS DISTINCT FROM 0
     OR NEW.claim_token IS NOT NULL
     OR NEW.claim_owner IS NOT NULL
     OR NEW.claim_version IS DISTINCT FROM 0
     OR NEW.lease_expires_at IS NOT NULL
     OR NEW.provider_call_started IS NOT NULL
     OR NEW.adapter IS NOT NULL
     OR NEW.dispatch_binding_version IS NOT NULL
     OR NEW.dispatch_binding_sha256 IS NOT NULL
     OR NEW.provider_correlation_version IS NOT NULL
     OR NEW.provider_evidence_version IS NOT NULL
     OR NEW.provider_evidence_sha256 IS NOT NULL
     OR NEW.provider_message_id IS NOT NULL
     OR NEW.sent_at IS NOT NULL
     OR NEW.quarantined_at IS NOT NULL
     OR NEW.last_error_code IS NOT NULL
  THEN
    RAISE EXCEPTION
      'email outbox delivery state must be pristine while held'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_delivery_hold_valid';
  END IF;

  NEW.delivery_hold_version := 'task7-v1';

  IF NEW.idempotency_original_payload_sha256 IS NOT NULL THEN
    RAISE EXCEPTION 'email outbox payload authority digest is database-owned'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_idempotency_authority_valid';
  END IF;

  -- Replay-conflict evidence only; not provider-delivery authorization.
  -- Validate every identity input before a prior authority can return NULL.
  IF pg_catalog.jsonb_typeof(NEW.variables) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'email outbox replay variables must be a JSON object'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_variables_object_valid';
  END IF;
  IF (
    NEW.to_email IS NOT NULL
    AND pg_catalog.encode(
      pg_catalog.convert_to(NEW.to_email, 'UTF8'),
      'hex'
    ) ~ '^([0-7][0-9a-f])+$'
    AND pg_catalog.btrim(NEW.to_email) = NEW.to_email
    AND pg_catalog.lower(NEW.to_email COLLATE "C") = NEW.to_email
  ) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'email outbox replay recipient must be canonical ASCII'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_recipient_canonical_valid';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_catalog.jsonb_object_keys(NEW.variables)
        AS envelope_key(name)
     WHERE pg_catalog.lower(envelope_key.name COLLATE "C") = ANY(
       ARRAY[
         '_mailoperationid',
         '_mailrecipient',
         '_mailproducer',
         '_mailsourceid',
         '_mailaudienceid'
       ]::pg_catalog.text[]
     )
       AND NOT (envelope_key.name = ANY(reserved_envelope_keys))
  ) THEN
    RAISE EXCEPTION 'email outbox replay envelope key casing is invalid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_idempotency_authority_valid';
  END IF;

  IF NEW.user_id IS NOT NULL THEN
    IF NEW.delivery_scope_key IS DISTINCT FROM 'a:' || NEW.user_id
       OR NEW.variables ?| reserved_envelope_keys
       OR NEW.template IN (
         'access-request-admin',
         'invitation',
         'access-rejected'
       )
    THEN
      RAISE EXCEPTION 'account email outbox replay envelope is invalid'
        USING ERRCODE = '23514',
              CONSTRAINT = 'email_outbox_idempotency_authority_valid';
    END IF;
  ELSE
    IF NEW.delivery_scope_key IS DISTINCT FROM
         's:' || NEW.operation_id::pg_catalog.text
       OR NEW.template_version IS DISTINCT FROM '1'
       OR NOT (NEW.variables ?& reserved_envelope_keys)
       OR NEW.variables ->> '_mailOperationId'
            IS DISTINCT FROM NEW.operation_id::pg_catalog.text
       OR NEW.variables ->> '_mailRecipient'
            IS DISTINCT FROM NEW.to_email
       OR (
         NEW.variables ->> '_mailSourceId' ~
           '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       ) IS DISTINCT FROM TRUE
       OR (
         NEW.variables ->> '_mailAudienceId' ~
           '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       ) IS DISTINCT FROM TRUE
       OR (
         (
           NEW.template = 'access-request-admin'
           AND NEW.variables ->> '_mailProducer' =
             'access-request-admin'
         )
         OR (
           NEW.template = 'invitation'
           AND NEW.variables ->> '_mailProducer' =
             'access-request-approved'
         )
         OR (
           NEW.template = 'access-rejected'
           AND NEW.variables ->> '_mailProducer' =
             'access-request-rejected'
         )
       ) IS DISTINCT FROM TRUE
    THEN
      RAISE EXCEPTION 'system email outbox replay envelope is invalid'
        USING ERRCODE = '23514',
              CONSTRAINT = 'email_outbox_idempotency_authority_valid';
    END IF;
  END IF;

  IF NEW.idempotency_authority_version IS NULL
     AND NEW.idempotency_authority_sha256 IS NULL
     AND NEW.template = 'backup-status'
     AND (
       NEW.idempotency_key ~ '^backup-status:v1:[0-9]{8}T[0-9]{6}Z$'
       OR NEW.idempotency_key ~
         '^backup-status:v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     )
     AND session_user = 'learncoding_backup_reporter'
     AND current_user = 'learncoding_owner'
  THEN
    backup_run_key := pg_catalog.substr(
      NEW.idempotency_key,
      pg_catalog.length('backup-status:v1:') + 1
    );
    backup_outcome := CASE NEW.variables ->> 'summary'
      WHEN
        'The nightly encrypted backup completed and passed local verification. No archive is attached to this email.'
        THEN 'success'
      WHEN
        'The nightly encrypted backup did not complete. Review the protected operations logs; no archive or log is attached to this email.'
        THEN 'failure'
      ELSE NULL
    END;
    IF backup_outcome IS NULL
       OR NEW.user_id IS NULL
       OR NEW.delivery_scope_key IS DISTINCT FROM 'a:' || NEW.user_id
       OR NEW.template_version IS DISTINCT FROM '1'
    THEN
      RAISE EXCEPTION 'backup status replay authority input is invalid'
        USING ERRCODE = '23514',
              CONSTRAINT = 'email_outbox_idempotency_authority_valid';
    END IF;
    NEW.idempotency_authority_version := 'event-v1-source-map';
    NEW.idempotency_authority_sha256 :=
      public.email_outbox_event_sha256(
        NEW.template,
        'a:' || NEW.user_id,
        backup_outcome || ':' || backup_run_key
      );
  ELSE
    IF NEW.idempotency_authority_version IS DISTINCT FROM 'event-v1-native' THEN
      RAISE EXCEPTION
        'new email outbox rows require event-v1-native authority'
        USING ERRCODE = '23514',
              CONSTRAINT = 'email_outbox_idempotency_authority_valid';
    END IF;
    IF NEW.idempotency_authority_sha256 IS NOT NULL THEN
      RAISE EXCEPTION
        'email outbox idempotency authority digest is database-owned'
        USING ERRCODE = '23514',
              CONSTRAINT = 'email_outbox_idempotency_authority_valid';
    END IF;
    IF NEW.idempotency_key !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION
        'event-v1-native email outbox idempotency key must be lowercase SHA-256'
        USING ERRCODE = '23514',
              CONSTRAINT = 'email_outbox_idempotency_authority_valid';
    END IF;
    NEW.idempotency_authority_sha256 := NEW.idempotency_key;
  END IF;

  NEW.idempotency_original_payload_sha256 :=
    public.email_outbox_original_payload_sha256(
      NEW.user_id,
      NEW.to_email,
      NEW.template,
      NEW.template_version,
      NEW.variables
    );

  prior_lock_timeout := pg_catalog.current_setting('lock_timeout');
  lock_timeout_was_clamped :=
    prior_lock_timeout = '0'
    OR EXTRACT(EPOCH FROM prior_lock_timeout::pg_catalog.interval) > 5;
  IF lock_timeout_was_clamped THEN
    PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
  END IF;
  BEGIN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(NEW.idempotency_authority_sha256, 0)
    );
  EXCEPTION
    WHEN OTHERS THEN
      IF lock_timeout_was_clamped THEN
        PERFORM pg_catalog.set_config('lock_timeout', prior_lock_timeout, true);
      END IF;
      RAISE;
  END;
  IF lock_timeout_was_clamped THEN
    PERFORM pg_catalog.set_config('lock_timeout', prior_lock_timeout, true);
  END IF;

  SELECT authority.original_payload_sha256
    INTO prior_original_payload_sha256
    FROM public.email_outbox_idempotency_authority AS authority
   WHERE authority.idempotency_sha256 =
     NEW.idempotency_authority_sha256;

  IF NOT FOUND THEN
    SELECT prior_outbox.idempotency_original_payload_sha256
      INTO prior_original_payload_sha256
      FROM public.email_outbox AS prior_outbox
     WHERE prior_outbox.idempotency_authority_sha256 =
       NEW.idempotency_authority_sha256
     ORDER BY prior_outbox.id
     LIMIT 1;
    IF NOT FOUND THEN
      RETURN NEW;
    END IF;
  END IF;

  IF prior_original_payload_sha256
     IS DISTINCT FROM NEW.idempotency_original_payload_sha256
  THEN
    RAISE EXCEPTION 'email outbox idempotency event payload conflict'
      USING ERRCODE = '23505',
            CONSTRAINT = 'email_outbox_idempotency_authority_pkey';
  END IF;
  RETURN NULL;
END
$function$;--> statement-breakpoint
CREATE FUNCTION public.persist_email_outbox_idempotency_authority()
RETURNS pg_catalog.trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  INSERT INTO public.email_outbox_idempotency_authority (
    idempotency_sha256,
    original_payload_sha256
  )
  VALUES (
    NEW.idempotency_authority_sha256,
    NEW.idempotency_original_payload_sha256
  );
  RETURN NULL;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION
      'unexpected email outbox idempotency authority conflict'
      USING ERRCODE = '23505',
            CONSTRAINT = 'email_outbox_idempotency_authority_pkey';
END
$function$;--> statement-breakpoint
CREATE FUNCTION public.enforce_email_outbox_idempotency_metadata_immutable()
RETURNS pg_catalog.trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.idempotency_authority_version
       IS DISTINCT FROM OLD.idempotency_authority_version
     OR NEW.idempotency_authority_sha256
       IS DISTINCT FROM OLD.idempotency_authority_sha256
     OR NEW.idempotency_original_payload_sha256
       IS DISTINCT FROM OLD.idempotency_original_payload_sha256
  THEN
    RAISE EXCEPTION
      'email outbox idempotency authority metadata is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_idempotency_authority_valid';
  END IF;
  RETURN NEW;
END
$function$;--> statement-breakpoint

CREATE FUNCTION public.enforce_email_outbox_idempotency_append_only()
RETURNS pg_catalog.trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'email outbox idempotency authority is append-only'
    USING ERRCODE = '55000';
END
$function$;--> statement-breakpoint

CREATE FUNCTION public.email_outbox_idempotency_coverage_authority(
  candidate_ids pg_catalog.uuid[]
)
RETURNS pg_catalog.boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  candidate_count pg_catalog.int4;
  unique_count pg_catalog.int4;
  covered pg_catalog.bool;
  prior_lock_timeout pg_catalog.text;
  lock_timeout_was_clamped pg_catalog.bool := false;
BEGIN
  candidate_count := pg_catalog.cardinality(candidate_ids);
  IF candidate_ids IS NULL
     OR candidate_count IS NULL
     OR candidate_count NOT BETWEEN 1 AND 5000
  THEN
    RAISE EXCEPTION 'invalid email outbox idempotency coverage request'
      USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.count(DISTINCT candidate_id)::pg_catalog.int4
    INTO unique_count
    FROM pg_catalog.unnest(candidate_ids) AS input(candidate_id);
  IF unique_count IS DISTINCT FROM candidate_count THEN
    RAISE EXCEPTION 'invalid email outbox idempotency coverage request'
      USING ERRCODE = '22023';
  END IF;

  prior_lock_timeout := pg_catalog.current_setting('lock_timeout');
  lock_timeout_was_clamped :=
    prior_lock_timeout = '0'
    OR EXTRACT(EPOCH FROM prior_lock_timeout::pg_catalog.interval) > 5;
  IF lock_timeout_was_clamped THEN
    PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
  END IF;
  BEGIN
    WITH locked_outbox AS MATERIALIZED (
      SELECT
        outbox.id,
        outbox.idempotency_key,
        outbox.idempotency_authority_version,
        outbox.idempotency_authority_sha256,
        outbox.idempotency_original_payload_sha256,
        CASE
          WHEN outbox.idempotency_authority_version IN (
            'event-v1-native',
            'event-v1-source-map'
          ) THEN outbox.idempotency_authority_sha256
          ELSE pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(outbox.idempotency_key, 'UTF8')
            ),
            'hex'
          )
        END AS effective_authority_sha256
      FROM public.email_outbox AS outbox
      WHERE outbox.id = ANY(candidate_ids)
      ORDER BY outbox.id
      FOR UPDATE OF outbox
    )
    SELECT
      pg_catalog.count(*) = candidate_count
      AND COALESCE(
        pg_catalog.bool_and(
          (
            (
              outbox.idempotency_authority_version IN (
                'event-v1-native',
                'event-v1-source-map'
              )
              AND outbox.idempotency_authority_sha256 ~ '^[0-9a-f]{64}$'
              AND (
                outbox.idempotency_authority_version <> 'event-v1-native'
                OR outbox.idempotency_authority_sha256 =
                  outbox.idempotency_key
              )
            )
            OR (
              outbox.idempotency_authority_version IN (
                'legacy-key-source-one-shot-v1',
                'legacy-key-terminal-cas-v1',
                'legacy-key-protocol-retired-v1',
                'legacy-key-fresh-action-v1',
                'legacy-key-blocked-v1'
              )
              AND outbox.idempotency_authority_sha256 IS NULL
            )
          ) IS TRUE
          AND authority.idempotency_sha256
            IS NOT DISTINCT FROM outbox.effective_authority_sha256
          AND authority.original_payload_sha256
            IS NOT DISTINCT FROM
              outbox.idempotency_original_payload_sha256
        ),
        false
      )
      INTO covered
      FROM locked_outbox AS outbox
      LEFT JOIN public.email_outbox_idempotency_authority AS authority
        ON authority.idempotency_sha256 =
          outbox.effective_authority_sha256;
  EXCEPTION
    WHEN OTHERS THEN
      IF lock_timeout_was_clamped THEN
        PERFORM pg_catalog.set_config('lock_timeout', prior_lock_timeout, true);
      END IF;
      RAISE;
  END;
  IF lock_timeout_was_clamped THEN
    PERFORM pg_catalog.set_config('lock_timeout', prior_lock_timeout, true);
  END IF;

  RETURN COALESCE(covered, false);
END
$function$;--> statement-breakpoint
ALTER FUNCTION public.enforce_email_outbox_delivery_hold()
  OWNER TO learncoding_owner;--> statement-breakpoint
ALTER FUNCTION public.claim_email_outbox_idempotency_authority()
  OWNER TO learncoding_owner;--> statement-breakpoint
ALTER FUNCTION public.persist_email_outbox_idempotency_authority()
  OWNER TO learncoding_owner;--> statement-breakpoint
ALTER FUNCTION public.enforce_email_outbox_idempotency_metadata_immutable()
  OWNER TO learncoding_owner;--> statement-breakpoint
ALTER FUNCTION public.enforce_email_outbox_idempotency_append_only()
  OWNER TO learncoding_owner;--> statement-breakpoint
ALTER FUNCTION public.email_outbox_idempotency_coverage_authority(pg_catalog.uuid[])
  OWNER TO learncoding_owner;--> statement-breakpoint

DO $codestead_idempotency_acl_scrub$
DECLARE
  routine_oid pg_catalog.oid;
  routine_identity pg_catalog.text;
  relation_identity pg_catalog.text;
  acl_grantee pg_catalog.record;
  authority_column_row pg_catalog.record;
  column_row pg_catalog.record;
  grantee_sql pg_catalog.text;
  grantor_sql pg_catalog.text;
  migration_role_sql pg_catalog.text;
BEGIN
  SELECT pg_catalog.format('%I', current_user)
    INTO STRICT migration_role_sql;

  SELECT pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
    INTO STRICT relation_identity
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
   WHERE relation.oid =
     'public.email_outbox_idempotency_authority'::pg_catalog.regclass;

  FOR routine_oid IN
    SELECT pg_catalog.to_regprocedure(candidate.function_identity)::pg_catalog.oid
      FROM pg_catalog.unnest(ARRAY[
        'public.email_outbox_original_payload_sha256(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.jsonb)',
        'public.email_outbox_event_sha256(pg_catalog.text,pg_catalog.text,pg_catalog.text)',
        'public.enforce_email_outbox_delivery_hold()',
        'public.claim_email_outbox_idempotency_authority()',
        'public.persist_email_outbox_idempotency_authority()',
        'public.enforce_email_outbox_idempotency_metadata_immutable()',
        'public.enforce_email_outbox_idempotency_append_only()',
        'public.email_outbox_idempotency_coverage_authority(pg_catalog.uuid[])'
      ]::pg_catalog.text[]) AS candidate(function_identity)
  LOOP
    IF routine_oid IS NULL THEN
      RAISE EXCEPTION 'email outbox idempotency ACL routine is missing'
        USING ERRCODE = '42883';
    END IF;

    SELECT pg_catalog.format(
             '%I.%I(%s)',
             namespace.nspname,
             routine.proname,
             pg_catalog.pg_get_function_identity_arguments(routine.oid)
           )
      INTO STRICT routine_identity
      FROM pg_catalog.pg_proc AS routine
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = routine.pronamespace
     WHERE routine.oid = routine_oid;

    FOR acl_grantee IN
      SELECT DISTINCT access.grantee
        FROM pg_catalog.pg_proc AS routine
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            routine.proacl,
            pg_catalog.acldefault('f', routine.proowner)
          )
        ) AS access
       WHERE routine.oid = routine_oid
       ORDER BY access.grantee
    LOOP
      IF acl_grantee.grantee = 0 THEN
        grantee_sql := 'PUBLIC';
      ELSE
        SELECT pg_catalog.format('%I', role.rolname)
          INTO STRICT grantee_sql
          FROM pg_catalog.pg_roles AS role
         WHERE role.oid = acl_grantee.grantee;
      END IF;

      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %s CASCADE',
        routine_identity,
        grantee_sql
      );
    END LOOP;
  END LOOP;

  FOR authority_column_row IN
    SELECT attribute.attname, attribute.attacl
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid =
       'public.email_outbox_idempotency_authority'::pg_catalog.regclass
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
     ORDER BY attribute.attnum
  LOOP
    FOR acl_grantee IN
      SELECT DISTINCT access.grantor, access.grantee
        FROM pg_catalog.aclexplode(authority_column_row.attacl) AS access
       ORDER BY access.grantor, access.grantee
    LOOP
      SELECT pg_catalog.format('%I', role.rolname)
        INTO STRICT grantor_sql
        FROM pg_catalog.pg_roles AS role
       WHERE role.oid = acl_grantee.grantor;

      IF acl_grantee.grantee = 0 THEN
        grantee_sql := 'PUBLIC';
      ELSE
        SELECT pg_catalog.format('%I', role.rolname)
          INTO STRICT grantee_sql
          FROM pg_catalog.pg_roles AS role
         WHERE role.oid = acl_grantee.grantee;
      END IF;

      BEGIN
        EXECUTE pg_catalog.format('SET LOCAL ROLE %s', grantor_sql);
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES (%I) ON TABLE %s FROM %s CASCADE',
          authority_column_row.attname,
          relation_identity,
          grantee_sql
        );
      EXCEPTION
        WHEN OTHERS THEN
          EXECUTE 'RESET ROLE';
          EXECUTE pg_catalog.format(
            'SET LOCAL ROLE %s',
            migration_role_sql
          );
          RAISE;
      END;
      EXECUTE 'RESET ROLE';
      EXECUTE pg_catalog.format('SET LOCAL ROLE %s', migration_role_sql);
    END LOOP;
  END LOOP;

  FOR acl_grantee IN
    SELECT DISTINCT access.grantee
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS access
     WHERE relation.oid =
       'public.email_outbox_idempotency_authority'::pg_catalog.regclass
     ORDER BY access.grantee
  LOOP
    IF acl_grantee.grantee = 0 THEN
      grantee_sql := 'PUBLIC';
    ELSE
      SELECT pg_catalog.format('%I', role.rolname)
        INTO STRICT grantee_sql
        FROM pg_catalog.pg_roles AS role
       WHERE role.oid = acl_grantee.grantee;
    END IF;

    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE %s FROM %s CASCADE',
      relation_identity,
      grantee_sql
    );
  END LOOP;

  SELECT pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
    INTO STRICT relation_identity
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
   WHERE relation.oid = 'public.email_outbox'::pg_catalog.regclass;

  FOR column_row IN
    SELECT attribute.attname, attribute.attacl
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = 'public.email_outbox'::pg_catalog.regclass
       AND attribute.attname IN (
         'idempotency_authority_version',
         'idempotency_authority_sha256',
         'idempotency_original_payload_sha256',
         'delivery_hold_version'
       )
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
     ORDER BY attribute.attnum
  LOOP
    FOR acl_grantee IN
      SELECT DISTINCT access.grantee
        FROM pg_catalog.aclexplode(column_row.attacl) AS access
       ORDER BY access.grantee
    LOOP
      IF acl_grantee.grantee = 0 THEN
        grantee_sql := 'PUBLIC';
      ELSE
        SELECT pg_catalog.format('%I', role.rolname)
          INTO STRICT grantee_sql
          FROM pg_catalog.pg_roles AS role
         WHERE role.oid = acl_grantee.grantee;
      END IF;

      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES (%I) ON TABLE %s FROM %s CASCADE',
        column_row.attname,
        relation_identity,
        grantee_sql
      );
    END LOOP;
  END LOOP;
END
$codestead_idempotency_acl_scrub$;--> statement-breakpoint

GRANT EXECUTE ON FUNCTION public.email_outbox_original_payload_sha256(
  pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.text, pg_catalog.jsonb
) TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.email_outbox_event_sha256(pg_catalog.text, pg_catalog.text, pg_catalog.text)
  TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.enforce_email_outbox_delivery_hold()
  TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.claim_email_outbox_idempotency_authority()
  TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.persist_email_outbox_idempotency_authority()
  TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  public.enforce_email_outbox_idempotency_metadata_immutable()
  TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  public.enforce_email_outbox_idempotency_append_only()
  TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  public.email_outbox_idempotency_coverage_authority(pg_catalog.uuid[])
  TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  public.email_outbox_idempotency_coverage_authority(pg_catalog.uuid[])
  TO learncoding_ops;--> statement-breakpoint
GRANT ALL PRIVILEGES
  ON TABLE public.email_outbox_idempotency_authority
  TO learncoding_owner;--> statement-breakpoint
GRANT INSERT (idempotency_authority_version)
  ON TABLE public.email_outbox
  TO learncoding_app, learncoding_worker;--> statement-breakpoint

DO $codestead_idempotency_acl_verify$
DECLARE
  function_contract pg_catalog.record;
  routine_row pg_catalog.record;
  function_acl pg_catalog.text[];
  expected_function_acl pg_catalog.text[];
  relation_row pg_catalog.record;
  authority_column_row pg_catalog.record;
  column_row pg_catalog.record;
  column_acl pg_catalog.text[];
  expected_column_acl pg_catalog.text[];
  checked_functions pg_catalog.integer := 0;
  checked_columns pg_catalog.integer := 0;
BEGIN
  FOR function_contract IN
    SELECT *
      FROM (VALUES
        ('public.email_outbox_original_payload_sha256(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.jsonb)', false),
        ('public.email_outbox_event_sha256(pg_catalog.text,pg_catalog.text,pg_catalog.text)', false),
        ('public.enforce_email_outbox_delivery_hold()', false),
        ('public.claim_email_outbox_idempotency_authority()', false),
        ('public.persist_email_outbox_idempotency_authority()', false),
        ('public.enforce_email_outbox_idempotency_metadata_immutable()', false),
        ('public.enforce_email_outbox_idempotency_append_only()', false),
        ('public.email_outbox_idempotency_coverage_authority(pg_catalog.uuid[])', true)
      ) AS contract(function_identity, allow_ops)
  LOOP
    checked_functions := checked_functions + 1;
    SELECT routine.proowner,
           pg_catalog.pg_get_userbyid(routine.proowner) AS owner_name,
           routine.proacl,
           routine.prosecdef,
           routine.proconfig
      INTO STRICT routine_row
      FROM pg_catalog.pg_proc AS routine
     WHERE routine.oid =
       pg_catalog.to_regprocedure(function_contract.function_identity);

    SELECT COALESCE(
             pg_catalog.array_agg(
               pg_catalog.format(
                 '%s|%s|%s',
                 CASE WHEN access.grantee = 0
                   THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(access.grantee)
                 END,
                 pg_catalog.lower(access.privilege_type),
                 access.is_grantable::pg_catalog.text
               )
               ORDER BY
                 CASE WHEN access.grantee = 0
                   THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(access.grantee)
                 END,
                 pg_catalog.lower(access.privilege_type),
                 access.is_grantable
             ),
             ARRAY[]::pg_catalog.text[]
           )
      INTO function_acl
      FROM pg_catalog.aclexplode(
        COALESCE(
          routine_row.proacl,
          pg_catalog.acldefault('f', routine_row.proowner)
        )
      ) AS access;

    expected_function_acl := CASE WHEN function_contract.allow_ops THEN
      ARRAY[
        'learncoding_ops|execute|false',
        'learncoding_owner|execute|false'
      ]::pg_catalog.text[]
    ELSE
      ARRAY['learncoding_owner|execute|false']::pg_catalog.text[]
    END;

    IF routine_row.owner_name IS DISTINCT FROM 'learncoding_owner'
       OR NOT routine_row.prosecdef
       OR routine_row.proconfig IS DISTINCT FROM
            ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
       OR function_acl IS DISTINCT FROM expected_function_acl
    THEN
      RAISE EXCEPTION
        'email outbox idempotency function ACL contract failed for %',
        function_contract.function_identity
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  IF checked_functions <> 8 THEN
    RAISE EXCEPTION 'email outbox idempotency functions are incomplete'
      USING ERRCODE = '42883';
  END IF;

  SELECT relation.relowner,
         pg_catalog.pg_get_userbyid(relation.relowner) AS owner_name,
         relation.relacl
    INTO STRICT relation_row
    FROM pg_catalog.pg_class AS relation
   WHERE relation.oid =
     'public.email_outbox_idempotency_authority'::pg_catalog.regclass;

  IF relation_row.owner_name IS DISTINCT FROM 'learncoding_owner'
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.aclexplode(
           COALESCE(
             relation_row.relacl,
             pg_catalog.acldefault('r', relation_row.relowner)
           )
         ) AS access
        WHERE access.grantee <> relation_row.relowner
     )
  THEN
    RAISE EXCEPTION
      'email outbox idempotency authority table ACL contract failed'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS access
     WHERE attribute.attrelid =
       'public.email_outbox_idempotency_authority'::pg_catalog.regclass
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
  )
  THEN
    RAISE EXCEPTION
      'email outbox idempotency authority table column ACL contract failed'
      USING ERRCODE = '42501',
            DETAIL = (
              SELECT pg_catalog.string_agg(
                       pg_catalog.format(
                         '%I:%s',
                         attribute.attname,
                         attribute.attacl::pg_catalog.text
                       ),
                       ',' ORDER BY attribute.attnum
                     )
                FROM pg_catalog.pg_attribute AS attribute
               WHERE attribute.attrelid =
                 'public.email_outbox_idempotency_authority'::pg_catalog.regclass
                 AND attribute.attacl IS NOT NULL
                 AND attribute.attnum > 0
                 AND NOT attribute.attisdropped
            );
  END IF;

  FOR column_row IN
    SELECT attribute.attname, attribute.attacl
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = 'public.email_outbox'::pg_catalog.regclass
       AND attribute.attname IN (
         'idempotency_authority_version',
         'idempotency_authority_sha256',
         'idempotency_original_payload_sha256',
         'delivery_hold_version'
       )
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
     ORDER BY attribute.attnum
  LOOP
    checked_columns := checked_columns + 1;
    SELECT COALESCE(
             pg_catalog.array_agg(
               pg_catalog.format(
                 '%s|%s|%s',
                 CASE WHEN access.grantee = 0
                   THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(access.grantee)
                 END,
                 pg_catalog.lower(access.privilege_type),
                 access.is_grantable::pg_catalog.text
               )
               ORDER BY
                 CASE WHEN access.grantee = 0
                   THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(access.grantee)
                 END,
                 pg_catalog.lower(access.privilege_type),
                 access.is_grantable
             ),
             ARRAY[]::pg_catalog.text[]
           )
      INTO column_acl
      FROM pg_catalog.aclexplode(column_row.attacl) AS access;

    expected_column_acl := CASE
      WHEN column_row.attname = 'idempotency_authority_version' THEN
        ARRAY[
          'learncoding_app|insert|false',
          'learncoding_worker|insert|false'
        ]::pg_catalog.text[]
      ELSE ARRAY[]::pg_catalog.text[]
    END;

    IF column_acl IS DISTINCT FROM expected_column_acl THEN
      RAISE EXCEPTION
        'email outbox idempotency column ACL contract failed for %',
        column_row.attname
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  IF checked_columns <> 4 THEN
    RAISE EXCEPTION 'email outbox idempotency columns are incomplete'
      USING ERRCODE = '42703';
  END IF;
END
$codestead_idempotency_acl_verify$;--> statement-breakpoint
CREATE TRIGGER email_outbox_delivery_hold
BEFORE UPDATE OF
  idempotency_authority_version,
  idempotency_authority_sha256,
  idempotency_original_payload_sha256,
  status,
  attempt_count,
  claim_token,
  claim_owner,
  claim_version,
  lease_expires_at,
  provider_call_started,
  adapter,
  dispatch_binding_version,
  dispatch_binding_sha256,
  provider_correlation_version,
  provider_evidence_version,
  provider_evidence_sha256,
  provider_message_id,
  next_attempt_at,
  sent_at,
  quarantined_at,
  last_error_code,
  delivery_hold_version
ON public.email_outbox
FOR EACH ROW
EXECUTE FUNCTION public.enforce_email_outbox_delivery_hold();--> statement-breakpoint

CREATE TRIGGER email_outbox_idempotency_claim
BEFORE INSERT ON public.email_outbox
FOR EACH ROW
EXECUTE FUNCTION public.claim_email_outbox_idempotency_authority();--> statement-breakpoint

CREATE TRIGGER "00_email_outbox_idempotency_persist"
AFTER INSERT ON public.email_outbox
FOR EACH ROW
EXECUTE FUNCTION public.persist_email_outbox_idempotency_authority();--> statement-breakpoint

CREATE TRIGGER email_outbox_idempotency_metadata_immutable
BEFORE UPDATE OF
  idempotency_key,
  idempotency_authority_version,
  idempotency_authority_sha256,
  idempotency_original_payload_sha256
ON public.email_outbox
FOR EACH ROW
EXECUTE FUNCTION
  public.enforce_email_outbox_idempotency_metadata_immutable();--> statement-breakpoint

CREATE TRIGGER email_outbox_idempotency_append_only
BEFORE UPDATE OR DELETE
ON public.email_outbox_idempotency_authority
FOR EACH ROW
EXECUTE FUNCTION
  public.enforce_email_outbox_idempotency_append_only();--> statement-breakpoint

CREATE TRIGGER email_outbox_idempotency_no_truncate
BEFORE TRUNCATE
ON public.email_outbox_idempotency_authority
FOR EACH STATEMENT
EXECUTE FUNCTION
  public.enforce_email_outbox_idempotency_append_only();--> statement-breakpoint

-- Replication-role sessions do not bypass authority ownership or append-only
-- enforcement. Foreign-key integrity remains an independent deferrable backstop.
ALTER TABLE public.email_outbox
  ENABLE ALWAYS TRIGGER email_outbox_delivery_hold;--> statement-breakpoint
ALTER TABLE public.email_outbox
  ENABLE ALWAYS TRIGGER email_outbox_idempotency_claim;--> statement-breakpoint
ALTER TABLE public.email_outbox
  ENABLE ALWAYS TRIGGER "00_email_outbox_idempotency_persist";--> statement-breakpoint
ALTER TABLE public.email_outbox
  ENABLE ALWAYS TRIGGER email_outbox_idempotency_metadata_immutable;--> statement-breakpoint
ALTER TABLE public.email_outbox_idempotency_authority
  ENABLE ALWAYS TRIGGER email_outbox_idempotency_append_only;--> statement-breakpoint
ALTER TABLE public.email_outbox_idempotency_authority
  ENABLE ALWAYS TRIGGER email_outbox_idempotency_no_truncate;--> statement-breakpoint

DO $codestead_delivery_hold_catalog_verify$
DECLARE
  hold_attribute pg_catalog.record;
  hold_constraint pg_catalog.record;
  hold_trigger pg_catalog.record;
  trigger_columns pg_catalog.text[];
  expected_trigger_columns CONSTANT pg_catalog.text[] := ARRAY[
    'adapter',
    'attempt_count',
    'claim_owner',
    'claim_token',
    'claim_version',
    'delivery_hold_version',
    'dispatch_binding_sha256',
    'dispatch_binding_version',
    'idempotency_authority_sha256',
    'idempotency_authority_version',
    'idempotency_original_payload_sha256',
    'last_error_code',
    'lease_expires_at',
    'next_attempt_at',
    'provider_call_started',
    'provider_correlation_version',
    'provider_evidence_sha256',
    'provider_evidence_version',
    'provider_message_id',
    'quarantined_at',
    'sent_at',
    'status'
  ]::pg_catalog.text[];
BEGIN
  SELECT attribute.attnum,
         attribute.atttypid,
         attribute.attnotnull,
         attribute.atthasdef,
         attribute.attgenerated,
         attribute.attidentity
    INTO STRICT hold_attribute
    FROM pg_catalog.pg_attribute AS attribute
   WHERE attribute.attrelid = 'public.email_outbox'::pg_catalog.regclass
     AND attribute.attname = 'delivery_hold_version'
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped;

  IF hold_attribute.atttypid <> 'pg_catalog.text'::pg_catalog.regtype
     OR NOT hold_attribute.attnotnull
     OR hold_attribute.atthasdef
     OR hold_attribute.attgenerated <> ''
     OR hold_attribute.attidentity <> ''
  THEN
    RAISE EXCEPTION 'email outbox delivery hold column is invalid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_delivery_hold_valid';
  END IF;

  SELECT constraint_row.contype,
         constraint_row.convalidated,
         constraint_row.conkey,
         pg_catalog.pg_get_expr(
           constraint_row.conbin, constraint_row.conrelid, false
         ) AS constraint_expression
    INTO STRICT hold_constraint
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid =
           'public.email_outbox'::pg_catalog.regclass
     AND constraint_row.conname = 'email_outbox_delivery_hold_valid';

  IF hold_constraint.contype <> 'c'
     OR NOT hold_constraint.convalidated
     OR hold_constraint.conkey IS DISTINCT FROM
          ARRAY[hold_attribute.attnum]::pg_catalog.int2[]
     OR hold_constraint.constraint_expression IS DISTINCT FROM
          '(delivery_hold_version = ''task7-v1''::text) IS TRUE'
  THEN
    RAISE EXCEPTION 'email outbox delivery hold constraint is invalid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_delivery_hold_valid';
  END IF;

  SELECT trigger_row.tgisinternal,
         trigger_row.tgconstraint,
         trigger_row.tgconstrrelid,
         trigger_row.tgtype,
         trigger_row.tgenabled,
         trigger_row.tgfoid,
         trigger_row.tgattr
    INTO STRICT hold_trigger
    FROM pg_catalog.pg_trigger AS trigger_row
   WHERE trigger_row.tgrelid = 'public.email_outbox'::pg_catalog.regclass
     AND trigger_row.tgname = 'email_outbox_delivery_hold';

  SELECT pg_catalog.array_agg(
           attribute.attname::pg_catalog.text
           ORDER BY attribute.attname::pg_catalog.text
         )
    INTO STRICT trigger_columns
    FROM pg_catalog.unnest(
           hold_trigger.tgattr::pg_catalog.int2[]
         ) AS trigger_attribute(attnum)
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = 'public.email_outbox'::pg_catalog.regclass
     AND attribute.attnum = trigger_attribute.attnum;

  IF hold_trigger.tgisinternal
     OR hold_trigger.tgconstraint <> 0
     OR hold_trigger.tgconstrrelid <> 0
     OR hold_trigger.tgtype <> 19
     OR hold_trigger.tgenabled <> 'A'
     OR hold_trigger.tgfoid <>
          pg_catalog.to_regprocedure(
            'public.enforce_email_outbox_delivery_hold()'
          )
     OR trigger_columns IS DISTINCT FROM expected_trigger_columns
  THEN
    RAISE EXCEPTION 'email outbox delivery hold trigger is invalid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_delivery_hold_valid';
  END IF;
EXCEPTION
  WHEN no_data_found OR too_many_rows THEN
    RAISE EXCEPTION 'email outbox delivery hold catalog is incomplete'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_delivery_hold_valid';
END
$codestead_delivery_hold_catalog_verify$;--> statement-breakpoint

DO $codestead_idempotency_trigger_order_verify$
DECLARE
  reviewed_fk_trigger_count pg_catalog.int4;
  reviewed_ordered_trigger_count pg_catalog.int4;
BEGIN
  SELECT pg_catalog.count(*)::pg_catalog.int4,
         pg_catalog.count(*) FILTER (WHERE (
           NOT reviewed_persist_trigger.tgisinternal
           AND reviewed_persist_trigger.tgconstraint = 0
           AND reviewed_persist_trigger.tgconstrrelid = 0
           AND reviewed_persist_trigger.tgrelid =
                 reviewed_foreign_key.conrelid
           AND reviewed_persist_trigger.tgtype = 5
           AND reviewed_persist_trigger.tgenabled = 'A'
           AND reviewed_persist_trigger.tgfoid =
                 pg_catalog.to_regprocedure(
                   'public.persist_email_outbox_idempotency_authority()'
                 )
           AND reviewed_fk_trigger.tgisinternal
           AND reviewed_fk_trigger.tgconstraint = reviewed_foreign_key.oid
           AND reviewed_fk_trigger.tgrelid = reviewed_foreign_key.conrelid
           AND reviewed_fk_trigger.tgconstrrelid =
                 reviewed_foreign_key.confrelid
           AND reviewed_fk_trigger.tgtype = 5
           AND reviewed_fk_trigger.tgenabled IN ('O', 'A')
           AND reviewed_fk_trigger.tgdeferrable =
                 reviewed_foreign_key.condeferrable
           AND reviewed_fk_trigger.tginitdeferred =
                 reviewed_foreign_key.condeferred
           AND reviewed_fk_trigger.tgfoid =
                 pg_catalog.to_regprocedure(
                   'pg_catalog."RI_FKey_check_ins"()'
                 )
           AND pg_catalog.convert_to(
                 reviewed_persist_trigger.tgname::pg_catalog.text,
                 'UTF8'
               ) < pg_catalog.convert_to(
                 reviewed_fk_trigger.tgname::pg_catalog.text,
                 'UTF8'
               )
         ))::pg_catalog.int4
    INTO STRICT reviewed_fk_trigger_count,
                reviewed_ordered_trigger_count
    FROM pg_catalog.pg_constraint AS reviewed_foreign_key
    JOIN pg_catalog.pg_trigger AS reviewed_fk_trigger
      ON reviewed_fk_trigger.tgconstraint = reviewed_foreign_key.oid
     AND reviewed_fk_trigger.tgrelid = reviewed_foreign_key.conrelid
     AND reviewed_fk_trigger.tgisinternal
     AND reviewed_fk_trigger.tgtype = 5
     AND reviewed_fk_trigger.tgfoid =
           pg_catalog.to_regprocedure(
             'pg_catalog."RI_FKey_check_ins"()'
           )
    JOIN pg_catalog.pg_trigger AS reviewed_persist_trigger
      ON reviewed_persist_trigger.tgrelid = reviewed_foreign_key.conrelid
     AND reviewed_persist_trigger.tgname =
           '00_email_outbox_idempotency_persist'
   WHERE reviewed_foreign_key.conrelid =
         'public.email_outbox'::pg_catalog.regclass
     AND reviewed_foreign_key.conname =
         'email_outbox_idempotency_authority_fk'
     AND reviewed_foreign_key.contype = 'f';

  IF reviewed_fk_trigger_count <> 1
     OR reviewed_ordered_trigger_count <> 1
  THEN
    RAISE EXCEPTION
      'email outbox idempotency FK trigger ordering is invalid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_idempotency_authority_fk';
  END IF;
END
$codestead_idempotency_trigger_order_verify$;
