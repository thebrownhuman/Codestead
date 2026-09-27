-- Forward-only fix for 0069. release_email_outbox_delivery() admits a
-- learncoding_worker session (worker-hosted producers such as the inactivity
-- scheduler insert and release in one transaction), but the
-- enforce_email_outbox_delivery_hold() marker-cleanup branch omitted that
-- session user, so every worker-session release failed with
-- "email outbox final immutable state is invalid". This migration changes only
-- that allowlist; every other guard (same xid, same cluster, exact release
-- receipt, no delivery/payload/updated_at change) is unchanged. Idempotent:
-- it replaces only the exact reviewed 0069 body or the exact 0070 body.
LOCK TABLE ONLY public.email_outbox
  IN ACCESS EXCLUSIVE MODE NOWAIT;--> statement-breakpoint
SET LOCAL search_path = pg_catalog, pg_temp;--> statement-breakpoint

DO $preflight_0070$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS routine
     WHERE routine.oid =
             'public.enforce_email_outbox_delivery_hold()'::pg_catalog.regprocedure
       AND routine.proowner = 'learncoding_owner'::pg_catalog.regrole
       AND routine.prosecdef
       AND routine.prolang = (
             SELECT language.oid FROM pg_catalog.pg_language AS language
              WHERE language.lanname = 'plpgsql'
           )
       AND pg_catalog.encode(
             pg_catalog.sha256(pg_catalog.convert_to(routine.prosrc, 'UTF8')),
             'hex'
           ) IN (
             '7636ab37cc17692c0c31d160dc5d7f0421d6660c0da2dfb6a2d8cae4501ea4e1',
             '19d65fe0291771ebfab04437e97d7663366851f37f7851ec4e4ea8380f33b72f'
           )
  ) THEN
    RAISE EXCEPTION '0070 delivery hold predecessor is invalid'
      USING ERRCODE = '23514';
  END IF;
END
$preflight_0070$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.enforce_email_outbox_delivery_hold()
RETURNS pg_catalog.trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  delivery_state_changed pg_catalog.bool;
  payload_changed pg_catalog.bool;
  marker_changed pg_catalog.bool;
  updated_at_changed pg_catalog.bool;
  exact_redaction pg_catalog.bool := false;
  exact_marker_cleanup pg_catalog.bool := false;
  redaction_disposition pg_catalog.text;
  expected_email pg_catalog.text;
  expected_variables pg_catalog.jsonb;
  old_claim_state_complete pg_catalog.bool;
  claim_state_complete pg_catalog.bool;
  old_claim_state_absent pg_catalog.bool;
  claim_state_absent pg_catalog.bool;
  old_provider_state_complete pg_catalog.bool;
  provider_state_complete pg_catalog.bool;
  old_provider_state_absent pg_catalog.bool;
  provider_state_absent pg_catalog.bool;
  next_generation pg_catalog.bool;
  retired_generation pg_catalog.bool;
  same_generation pg_catalog.bool;
  same_attempt pg_catalog.bool;
  same_claim_identity pg_catalog.bool;
  same_provider_authority pg_catalog.bool;
  same_provider_result pg_catalog.bool;
  same_schedule pg_catalog.bool;
  same_quarantine pg_catalog.bool;
  same_error pg_catalog.bool;
  bounded_new_lease pg_catalog.bool;
  guard_now pg_catalog.timestamptz := pg_catalog.clock_timestamp();
  current_system_identifier pg_catalog.int8;
  old_error_valid pg_catalog.bool;
  new_error_valid pg_catalog.bool;
  new_message_valid pg_catalog.bool;
  transition_allowed pg_catalog.bool;
BEGIN
  SELECT control.system_identifier
    INTO STRICT current_system_identifier
    FROM pg_catalog.pg_control_system() AS control;

  IF NEW.delivery_hold_version IS DISTINCT FROM OLD.delivery_hold_version
     OR NEW.delivery_hold_version IS DISTINCT FROM 'task7-v1'
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
     OR NEW.idempotency_authority_version
          IS DISTINCT FROM OLD.idempotency_authority_version
     OR NEW.idempotency_authority_sha256
          IS DISTINCT FROM OLD.idempotency_authority_sha256
     OR NEW.idempotency_original_payload_sha256
          IS DISTINCT FROM OLD.idempotency_original_payload_sha256
  THEN
    RAISE EXCEPTION 'email outbox permanent delivery identity is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_delivery_hold_valid';
  END IF;

  IF (OLD.provider_message_id IS NOT NULL OR OLD.sent_at IS NOT NULL)
     AND ROW(NEW.provider_message_id, NEW.sent_at)
           IS DISTINCT FROM ROW(OLD.provider_message_id, OLD.sent_at)
  THEN
    RAISE EXCEPTION 'email outbox provider identity is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_delivery_hold_valid';
  END IF;


  delivery_state_changed :=
    NEW.status IS DISTINCT FROM OLD.status
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
    OR NEW.provider_request_body_sha256
         IS DISTINCT FROM OLD.provider_request_body_sha256
    OR NEW.provider_request_body_length
         IS DISTINCT FROM OLD.provider_request_body_length
    OR NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at
    OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
    OR NEW.quarantined_at IS DISTINCT FROM OLD.quarantined_at
    OR NEW.last_error_code IS DISTINCT FROM OLD.last_error_code;

  payload_changed :=
    OLD.user_id IS DISTINCT FROM NEW.user_id
    OR OLD.to_email IS DISTINCT FROM NEW.to_email
    OR OLD.template IS DISTINCT FROM NEW.template
    OR OLD.template_version IS DISTINCT FROM NEW.template_version
    OR OLD.variables IS DISTINCT FROM NEW.variables
    OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
    OR OLD.delivery_scope_key IS DISTINCT FROM NEW.delivery_scope_key;
  marker_changed := ROW(
    OLD.delivery_release_insert_xid,
    OLD.delivery_release_insert_system_identifier
  ) IS DISTINCT FROM ROW(
    NEW.delivery_release_insert_xid,
    NEW.delivery_release_insert_system_identifier
  );
  updated_at_changed := OLD.updated_at IS DISTINCT FROM NEW.updated_at;

  IF OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'email outbox created_at is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_delivery_hold_valid';
  END IF;

  IF NOT delivery_state_changed
     AND current_user = 'learncoding_owner'
     AND session_user = 'learncoding_ops'
  THEN
    redaction_disposition :=
      public.classify_email_outbox_quarantine_redaction_v2(
        OLD,
        pg_catalog.statement_timestamp() - interval '30 days'
      );
    expected_email := 'redacted+' || OLD.id::pg_catalog.text
      || '@invalid.local';
    expected_variables := CASE
      WHEN redaction_disposition = 'eligible_system' THEN
        pg_catalog.jsonb_build_object(
          '_mailOperationId', OLD.operation_id::pg_catalog.text,
          '_mailRecipient', expected_email,
          '_mailProducer', OLD.variables ->> '_mailProducer',
          '_mailSourceId', OLD.variables ->> '_mailSourceId'
        ) || CASE
          WHEN OLD.variables ? '_mailAudienceId' THEN
            pg_catalog.jsonb_build_object(
              '_mailAudienceId', OLD.variables -> '_mailAudienceId'
            )
          ELSE '{}'::pg_catalog.jsonb
        END
      ELSE '{}'::pg_catalog.jsonb
    END;
    exact_redaction := (
      redaction_disposition IN (
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
      AND OLD.user_id IS NOT DISTINCT FROM NEW.user_id
      AND OLD.template IS NOT DISTINCT FROM NEW.template
      AND OLD.template_version IS NOT DISTINCT FROM NEW.template_version
      AND OLD.idempotency_key IS NOT DISTINCT FROM NEW.idempotency_key
      AND OLD.delivery_scope_key IS NOT DISTINCT FROM NEW.delivery_scope_key
      AND NOT marker_changed
      AND NEW.updated_at = pg_catalog.statement_timestamp()
    ) IS TRUE;
  END IF;

  IF NOT delivery_state_changed
     AND NOT payload_changed
     AND marker_changed
     AND NOT updated_at_changed
     AND current_user = 'learncoding_owner'
     AND session_user IN (
       'learncoding_app',
       'learncoding_worker',
       'learncoding_owner',
       'learncoding_backup_reporter'
     )
     AND OLD.delivery_release_insert_xid IS NOT NULL
     AND OLD.delivery_release_insert_xid
           IS NOT DISTINCT FROM pg_catalog.pg_current_xact_id()
     AND OLD.delivery_release_insert_system_identifier
           IS NOT DISTINCT FROM current_system_identifier
     AND NEW.delivery_release_insert_xid IS NULL
     AND NEW.delivery_release_insert_system_identifier IS NULL
     AND EXISTS (
       SELECT 1
         FROM ONLY public.mail_delivery_release_receipt AS release
        WHERE release.outbox_id = NEW.id
          AND release.operation_id = NEW.operation_id
          AND release.idempotency_authority_version =
                NEW.idempotency_authority_version
          AND release.idempotency_authority_sha256 =
                NEW.idempotency_authority_sha256
          AND release.idempotency_original_payload_sha256 =
                NEW.idempotency_original_payload_sha256
          AND release.release_version = NEW.delivery_hold_version
          AND release.release_receipt_sha256 =
                public.mail_delivery_release_receipt_sha256(
                  NEW.id,
                  NEW.operation_id,
                  NEW.idempotency_authority_version,
                  NEW.idempotency_authority_sha256,
                  NEW.idempotency_original_payload_sha256,
                  NEW.delivery_hold_version
                )
     )
  THEN
    exact_marker_cleanup := true;
  END IF;

  IF NOT delivery_state_changed THEN
    IF (
      NOT payload_changed
      AND NOT marker_changed
      AND NOT updated_at_changed
    ) OR exact_redaction OR exact_marker_cleanup
    THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'email outbox final immutable state is invalid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_delivery_hold_valid';
  END IF;

  IF payload_changed OR marker_changed THEN
    RAISE EXCEPTION 'email outbox delivery transition changed immutable payload'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_delivery_hold_valid';
  END IF;

  IF current_user IS DISTINCT FROM 'learncoding_owner'
     OR session_user IS DISTINCT FROM 'learncoding_worker'
  THEN
    RAISE EXCEPTION 'email outbox delivery state requires worker authority'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.delivery_release_insert_xid IS NOT NULL
     OR NEW.delivery_release_insert_system_identifier IS NOT NULL
     OR NOT EXISTS (
    SELECT 1
      FROM ONLY public.mail_delivery_release_receipt AS release
     WHERE NEW.idempotency_authority_version IN (
             'event-v1-native', 'event-v1-source-map'
           )
       AND release.outbox_id = NEW.id
       AND release.operation_id = NEW.operation_id
       AND release.idempotency_authority_version =
             NEW.idempotency_authority_version
       AND release.idempotency_authority_sha256 =
             NEW.idempotency_authority_sha256
       AND release.idempotency_original_payload_sha256 =
             NEW.idempotency_original_payload_sha256
       AND release.release_version = 'task7-v1'
       AND release.release_version = NEW.delivery_hold_version
       AND release.release_receipt_sha256 =
             public.mail_delivery_release_receipt_sha256(
               NEW.id,
               NEW.operation_id,
               NEW.idempotency_authority_version,
               NEW.idempotency_authority_sha256,
               NEW.idempotency_original_payload_sha256,
               NEW.delivery_hold_version
             )
  ) THEN
    RAISE EXCEPTION 'email outbox delivery remains held without exact release'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_delivery_hold_valid';
  END IF;

  IF NEW.updated_at IS DISTINCT FROM pg_catalog.statement_timestamp() THEN
    RAISE EXCEPTION 'email outbox delivery update timestamp is invalid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_delivery_hold_valid';
  END IF;

  old_claim_state_complete := (
    OLD.claim_token IS NOT NULL
    AND OLD.claim_owner IS NOT NULL
    AND OLD.claim_owner = pg_catalog.btrim(OLD.claim_owner)
    AND pg_catalog.char_length(OLD.claim_owner) BETWEEN 1 AND 128
    AND OLD.claim_version > 0
    AND OLD.attempt_count > 0
    AND OLD.lease_expires_at IS NOT NULL
  ) IS TRUE;

  claim_state_complete := (
    NEW.claim_token IS NOT NULL
    AND NEW.claim_owner IS NOT NULL
    AND NEW.claim_owner = pg_catalog.btrim(NEW.claim_owner)
    AND pg_catalog.char_length(NEW.claim_owner) BETWEEN 1 AND 128
    AND NEW.claim_version > 0
    AND NEW.attempt_count > 0
    AND NEW.lease_expires_at IS NOT NULL
  ) IS TRUE;

  old_claim_state_absent := (
    OLD.claim_token IS NULL
    AND OLD.claim_owner IS NULL
    AND OLD.lease_expires_at IS NULL
  ) IS TRUE;

  claim_state_absent := (
    NEW.claim_token IS NULL
    AND NEW.claim_owner IS NULL
    AND NEW.lease_expires_at IS NULL
  ) IS TRUE;

  old_provider_state_absent := (
    OLD.provider_call_started IS NULL
    AND OLD.adapter IS NULL
    AND OLD.dispatch_binding_version IS NULL
    AND OLD.dispatch_binding_sha256 IS NULL
    AND OLD.provider_correlation_version IS NULL
    AND OLD.provider_evidence_version IS NULL
    AND OLD.provider_evidence_sha256 IS NULL
    AND OLD.provider_request_body_sha256 IS NULL
    AND OLD.provider_request_body_length IS NULL
  ) IS TRUE;

  provider_state_absent := (
    NEW.provider_call_started IS NULL
    AND NEW.adapter IS NULL
    AND NEW.dispatch_binding_version IS NULL
    AND NEW.dispatch_binding_sha256 IS NULL
    AND NEW.provider_correlation_version IS NULL
    AND NEW.provider_evidence_version IS NULL
    AND NEW.provider_evidence_sha256 IS NULL
    AND NEW.provider_request_body_sha256 IS NULL
    AND NEW.provider_request_body_length IS NULL
  ) IS TRUE;

  old_provider_state_complete := (
    OLD.provider_call_started IS NOT NULL
    AND OLD.dispatch_binding_sha256 ~ '^[0-9a-f]{64}$'
    AND OLD.provider_correlation_version = 'opaque-sha256-v1'
    AND OLD.provider_request_body_sha256 ~ '^[0-9a-f]{64}$'
    AND OLD.provider_request_body_length BETWEEN 0 AND 9007199254740991
    AND (
      (
        OLD.adapter = 'gmail'
        AND OLD.dispatch_binding_version = 'gmail-raw-v1'
        AND OLD.provider_evidence_version = 'gmail-header-evidence-v1'
        AND OLD.provider_evidence_sha256 ~ '^[0-9a-f]{64}$'
      )
      OR (
        OLD.adapter = 'console'
        AND OLD.dispatch_binding_version = 'console-json-v1'
        AND OLD.provider_evidence_version IS NULL
        AND OLD.provider_evidence_sha256 IS NULL
      )
    )
  ) IS TRUE;

  provider_state_complete := (
    NEW.provider_call_started IS NOT NULL
    AND NEW.dispatch_binding_sha256 ~ '^[0-9a-f]{64}$'
    AND NEW.provider_correlation_version = 'opaque-sha256-v1'
    AND NEW.provider_request_body_sha256 ~ '^[0-9a-f]{64}$'
    AND NEW.provider_request_body_length BETWEEN 0 AND 9007199254740991
    AND (
      (
        NEW.adapter = 'gmail'
        AND NEW.dispatch_binding_version = 'gmail-raw-v1'
        AND NEW.provider_evidence_version = 'gmail-header-evidence-v1'
        AND NEW.provider_evidence_sha256 ~ '^[0-9a-f]{64}$'
      )
      OR (
        NEW.adapter = 'console'
        AND NEW.dispatch_binding_version = 'console-json-v1'
        AND NEW.provider_evidence_version IS NULL
        AND NEW.provider_evidence_sha256 IS NULL
      )
    )
  ) IS TRUE;

  next_generation := (
    OLD.claim_version::pg_catalog.int8 < 2147483647
    AND NEW.claim_version::pg_catalog.int8 =
          OLD.claim_version::pg_catalog.int8 + 1
  ) IS TRUE;
  retired_generation := (
    NEW.claim_version::pg_catalog.int8 = CASE
      WHEN OLD.claim_version::pg_catalog.int8 <
             2147483647::pg_catalog.int8
      THEN OLD.claim_version::pg_catalog.int8 + 1
      ELSE 2147483647::pg_catalog.int8
    END
  ) IS TRUE;
  same_generation := NEW.claim_version = OLD.claim_version;
  same_attempt := NEW.attempt_count = OLD.attempt_count;
  same_claim_identity := ROW(NEW.claim_token, NEW.claim_owner)
    IS NOT DISTINCT FROM ROW(OLD.claim_token, OLD.claim_owner);
  same_provider_authority := ROW(
    NEW.provider_call_started,
    NEW.adapter,
    NEW.dispatch_binding_version,
    NEW.dispatch_binding_sha256,
    NEW.provider_correlation_version,
    NEW.provider_evidence_version,
    NEW.provider_evidence_sha256,
    NEW.provider_request_body_sha256,
    NEW.provider_request_body_length
  ) IS NOT DISTINCT FROM ROW(
    OLD.provider_call_started,
    OLD.adapter,
    OLD.dispatch_binding_version,
    OLD.dispatch_binding_sha256,
    OLD.provider_correlation_version,
    OLD.provider_evidence_version,
    OLD.provider_evidence_sha256,
    OLD.provider_request_body_sha256,
    OLD.provider_request_body_length
  );
  same_provider_result := ROW(NEW.provider_message_id, NEW.sent_at)
    IS NOT DISTINCT FROM ROW(OLD.provider_message_id, OLD.sent_at);
  same_schedule := NEW.next_attempt_at IS NOT DISTINCT FROM OLD.next_attempt_at;
  same_quarantine := NEW.quarantined_at IS NOT DISTINCT FROM OLD.quarantined_at;
  same_error := NEW.last_error_code IS NOT DISTINCT FROM OLD.last_error_code;
  bounded_new_lease := (
    NEW.lease_expires_at
      >= guard_now + interval '15 seconds'
    AND NEW.lease_expires_at
      <= guard_now + interval '300 seconds'
  ) IS TRUE;
  old_error_valid := (
    OLD.last_error_code IS NOT NULL
    AND OLD.last_error_code = pg_catalog.btrim(OLD.last_error_code)
    AND pg_catalog.char_length(OLD.last_error_code) BETWEEN 1 AND 80
  ) IS TRUE;
  new_error_valid := (
    NEW.last_error_code IS NOT NULL
    AND NEW.last_error_code = pg_catalog.btrim(NEW.last_error_code)
    AND pg_catalog.char_length(NEW.last_error_code) BETWEEN 1 AND 80
  ) IS TRUE;
  new_message_valid := (
    NEW.provider_message_id IS NOT NULL
    AND NEW.provider_message_id = pg_catalog.btrim(NEW.provider_message_id)
    AND pg_catalog.char_length(NEW.provider_message_id) BETWEEN 1 AND 512
  ) IS TRUE;

  transition_allowed := (
    (
      OLD.status = 'pending'
      AND OLD.claim_version::pg_catalog.int8 BETWEEN 0 AND 2147483645
      AND OLD.attempt_count::pg_catalog.int8 BETWEEN 0 AND 2147483646
      AND old_claim_state_absent
      AND old_provider_state_absent
      AND OLD.provider_message_id IS NULL
      AND OLD.sent_at IS NULL
      AND OLD.quarantined_at IS NULL
      AND OLD.next_attempt_at <= guard_now
      AND NEW.status = 'sending'
      AND claim_state_complete
      AND next_generation
      AND NEW.attempt_count::pg_catalog.int8 =
            OLD.attempt_count::pg_catalog.int8 + 1
      AND NEW.claim_token IS DISTINCT FROM OLD.claim_token
      AND bounded_new_lease
      AND provider_state_absent
      AND same_provider_result
      AND same_schedule
      AND same_quarantine
      AND NEW.last_error_code IS NULL
    )
    OR (
      OLD.status = 'sending'
      AND old_claim_state_complete
      AND OLD.claim_version::pg_catalog.int8 <= 2147483645
      AND OLD.attempt_count::pg_catalog.int8 <= 2147483646
      AND OLD.lease_expires_at < guard_now
      AND old_provider_state_absent
      AND OLD.provider_message_id IS NULL
      AND OLD.sent_at IS NULL
      AND OLD.quarantined_at IS NULL
      AND NEW.status = 'sending'
      AND claim_state_complete
      AND next_generation
      AND NEW.attempt_count::pg_catalog.int8 =
            OLD.attempt_count::pg_catalog.int8 + 1
      AND NEW.claim_token IS DISTINCT FROM OLD.claim_token
      AND bounded_new_lease
      AND provider_state_absent
      AND same_provider_result
      AND same_schedule
      AND same_quarantine
      AND NEW.last_error_code IS NULL
    )
    OR (
      OLD.status = 'pending'
      AND old_claim_state_absent
      AND old_provider_state_absent
      AND OLD.provider_message_id IS NULL
      AND OLD.sent_at IS NULL
      AND OLD.quarantined_at IS NULL
      AND (
        OLD.claim_version::pg_catalog.int8 >= 2147483646
        OR OLD.attempt_count::pg_catalog.int8 = 2147483647
      )
      AND NEW.status = 'failed'
      AND claim_state_absent
      AND provider_state_absent
      AND retired_generation
      AND same_attempt
      AND same_provider_result
      AND same_schedule
      AND same_quarantine
      AND NEW.last_error_code = 'DELIVERY_COUNTER_EXHAUSTED'
    )
    OR (
      OLD.status = 'sending'
      AND old_claim_state_complete
      AND OLD.lease_expires_at <= guard_now
      AND old_provider_state_absent
      AND OLD.provider_message_id IS NULL
      AND OLD.sent_at IS NULL
      AND OLD.quarantined_at IS NULL
      AND (
        OLD.claim_version::pg_catalog.int8 >= 2147483646
        OR OLD.attempt_count::pg_catalog.int8 = 2147483647
      )
      AND NEW.status = 'failed'
      AND claim_state_absent
      AND provider_state_absent
      AND retired_generation
      AND same_attempt
      AND same_provider_result
      AND same_schedule
      AND same_quarantine
      AND NEW.last_error_code = 'DELIVERY_COUNTER_EXHAUSTED'
    )
    OR (
      OLD.status = 'sending'
      AND old_claim_state_complete
      AND OLD.lease_expires_at > guard_now
      AND old_provider_state_absent
      AND OLD.provider_message_id IS NULL
      AND OLD.sent_at IS NULL
      AND OLD.quarantined_at IS NULL
      AND (
        OLD.claim_version::pg_catalog.int8 >= 2147483645
        OR OLD.attempt_count::pg_catalog.int8 = 2147483647
      )
      AND NEW.status = 'failed'
      AND claim_state_absent
      AND provider_state_absent
      AND retired_generation
      AND same_attempt
      AND same_provider_result
      AND same_schedule
      AND same_quarantine
      AND NEW.last_error_code = 'DELIVERY_COUNTER_EXHAUSTED'
    )
    OR (
      OLD.status = 'sending'
      AND NEW.status = 'sending'
      AND old_claim_state_complete
      AND claim_state_complete
      AND same_generation
      AND same_attempt
      AND same_claim_identity
      AND OLD.lease_expires_at > guard_now
      AND bounded_new_lease
      AND NEW.lease_expires_at >= OLD.lease_expires_at
      AND old_provider_state_absent
      AND provider_state_complete
      AND NEW.provider_call_started = pg_catalog.statement_timestamp()
      AND same_provider_result
      AND same_schedule
      AND same_quarantine
      AND same_error
    )
    OR (
      OLD.status = 'sending'
      AND old_claim_state_complete
      AND OLD.claim_version::pg_catalog.int8 <= 2147483644
      AND OLD.attempt_count::pg_catalog.int8 <= 2147483646
      AND OLD.lease_expires_at > guard_now
      AND old_provider_state_absent
      AND OLD.provider_message_id IS NULL
      AND OLD.sent_at IS NULL
      AND OLD.quarantined_at IS NULL
      AND NEW.status = 'pending'
      AND claim_state_absent
      AND next_generation
      AND same_attempt
      AND provider_state_absent
      AND same_provider_result
      AND NEW.quarantined_at IS NULL
      AND new_error_valid
      AND NEW.next_attempt_at > guard_now
      AND pg_catalog.isfinite(NEW.next_attempt_at)
      AND NEW.next_attempt_at <= guard_now + interval '6 hours'
    )
    OR (
      OLD.status = 'sending'
      AND old_claim_state_complete
      AND OLD.claim_version::pg_catalog.int8 < 2147483647
      AND OLD.lease_expires_at > guard_now
      AND old_provider_state_absent
      AND OLD.provider_message_id IS NULL
      AND OLD.sent_at IS NULL
      AND OLD.quarantined_at IS NULL
      AND NEW.status IN ('failed', 'suppressed')
      AND claim_state_absent
      AND next_generation
      AND same_attempt
      AND provider_state_absent
      AND same_provider_result
      AND same_schedule
      AND NEW.quarantined_at IS NULL
      AND new_error_valid
    )
    OR (
      OLD.status = 'sending'
      AND old_claim_state_complete
      AND old_provider_state_complete
      AND OLD.provider_message_id IS NULL
      AND OLD.sent_at IS NULL
      AND OLD.quarantined_at IS NULL
      AND OLD.last_error_code IS NULL
      AND NEW.status = 'sent'
      AND claim_state_absent
      AND same_generation
      AND same_attempt
      AND provider_state_complete
      AND same_provider_authority
      AND new_message_valid
      AND NEW.sent_at = pg_catalog.statement_timestamp()
      AND NEW.quarantined_at IS NULL
      AND NEW.last_error_code IS NULL
      AND same_schedule
    )
    OR (
      OLD.status = 'sending'
      AND old_claim_state_complete
      AND old_provider_state_complete
      AND OLD.provider_message_id IS NULL
      AND OLD.sent_at IS NULL
      AND OLD.quarantined_at IS NULL
      AND OLD.last_error_code IS NULL
      AND NEW.status = 'failed'
      AND claim_state_absent
      AND same_generation
      AND same_attempt
      AND provider_state_complete
      AND same_provider_authority
      AND NEW.provider_message_id IS NULL
      AND NEW.sent_at IS NULL
      AND NEW.quarantined_at IS NULL
      AND new_error_valid
      AND same_schedule
    )
    OR (
      OLD.status = 'sending'
      AND old_claim_state_complete
      AND OLD.claim_version < 2147483647
      AND old_provider_state_complete
      AND OLD.provider_message_id IS NULL
      AND OLD.sent_at IS NULL
      AND OLD.quarantined_at IS NULL
      AND OLD.last_error_code IS NULL
      AND NEW.status = 'quarantined'
      AND claim_state_absent
      AND next_generation
      AND same_attempt
      AND provider_state_complete
      AND same_provider_authority
      AND same_provider_result
      AND same_schedule
      AND NEW.quarantined_at = pg_catalog.statement_timestamp()
      AND new_error_valid
    )
    OR (
      OLD.status = 'quarantined'
      AND old_claim_state_absent
      AND OLD.claim_version > 0
      AND OLD.attempt_count > 0
      AND old_provider_state_complete
      AND OLD.provider_message_id IS NULL
      AND OLD.sent_at IS NULL
      AND OLD.quarantined_at IS NOT NULL
      AND OLD.last_error_code = 'ABANDONED_POST_PROVIDER_BOUNDARY'
      AND NEW.status = 'quarantined'
      AND claim_state_absent
      AND same_generation
      AND same_attempt
      AND provider_state_complete
      AND same_provider_authority
      AND new_message_valid
      AND NEW.sent_at = pg_catalog.statement_timestamp()
      AND same_quarantine
      AND same_error
      AND same_schedule
    )
    OR (
      OLD.status = 'quarantined'
      AND old_claim_state_absent
      AND OLD.claim_version > 0
      AND OLD.attempt_count > 0
      AND old_provider_state_complete
      AND OLD.provider_message_id IS NULL
      AND OLD.sent_at IS NULL
      AND OLD.quarantined_at IS NOT NULL
      AND OLD.last_error_code = 'ABANDONED_POST_PROVIDER_BOUNDARY'
      AND NEW.status = 'failed'
      AND claim_state_absent
      AND same_generation
      AND same_attempt
      AND provider_state_complete
      AND same_provider_authority
      AND same_provider_result
      AND NEW.quarantined_at IS NULL
      AND new_error_valid
      AND same_schedule
    )
    OR (
      OLD.status = 'quarantined'
      AND old_claim_state_absent
      AND OLD.claim_version > 0
      AND OLD.attempt_count > 0
      AND old_provider_state_complete
      AND OLD.adapter = 'gmail'
      AND OLD.provider_message_id IS NULL
      AND OLD.sent_at IS NULL
      AND OLD.quarantined_at IS NOT NULL
      AND old_error_valid
      AND NEW.status = 'sent'
      AND claim_state_absent
      AND same_generation
      AND same_attempt
      AND provider_state_complete
      AND same_provider_authority
      AND new_message_valid
      AND NEW.sent_at = pg_catalog.statement_timestamp()
      AND NEW.quarantined_at IS NULL
      AND NEW.last_error_code IS NULL
      AND same_schedule
    )
  ) IS TRUE;

  IF transition_allowed IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'email outbox delivery state arc is invalid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_delivery_hold_valid';
  END IF;
  RETURN NEW;
END
$function$;--> statement-breakpoint

ALTER FUNCTION public.enforce_email_outbox_delivery_hold()
  OWNER TO learncoding_owner;
