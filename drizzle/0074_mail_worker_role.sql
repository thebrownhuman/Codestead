-- OWNER REVIEW DRAFT ONLY: migration 0074, not registered or executed.
-- Base: 4b067e4f0be4de0a11313ae6678dd5240154c19e / reviewed 0073.
-- The canonical privileged bootstrap must create the dedicated SCRAM-managed
-- login before migration. No password, CREATE ROLE, ownership membership, or
-- broadly inherited capability is included here. Activation stays fenced
-- until migration, exact capability reconciliation, and startup attestation pass.
-- Existing role ACLs and original callable routine ACLs remain unchanged.
SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '5s';

DO $mail_role_preflight_0074$
DECLARE principal pg_catalog.oid;
BEGIN
  IF session_user IS DISTINCT FROM 'learncoding_migrator'
     OR current_user IS DISTINCT FROM 'learncoding_owner' THEN
    RAISE EXCEPTION 'mail role migration requires checked owner authority' USING ERRCODE='42501';
  END IF;
  IF (SELECT count(*) FROM drizzle.__drizzle_migrations) <> 74
     OR NOT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations
        WHERE created_at=1791465167378
          AND hash='deda4463862553de0edac3996f32ad6617bf1297b5603a32a5750f8062293e46') THEN
    RAISE EXCEPTION 'mail role migration requires reviewed 0073';
  END IF;
  SELECT oid INTO principal FROM pg_catalog.pg_roles
   WHERE rolname='learncoding_mail_worker' AND NOT rolcanlogin
     AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
     AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls;
  IF principal IS NULL OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
        WHERE member=principal OR roleid=principal) THEN
    RAISE EXCEPTION 'mail role must be a fenced restricted principal without memberships';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl) access
    WHERE access.grantee=principal
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) access
    WHERE access.grantee=principal
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc routine
    CROSS JOIN LATERAL pg_catalog.aclexplode(routine.proacl) access
    WHERE access.grantee=principal
  ) THEN
    RAISE EXCEPTION 'mail role must start without object privileges';
  END IF;
END
$mail_role_preflight_0074$;
--> statement-breakpoint

LOCK TABLE ONLY public.email_outbox, ONLY public.mail_delivery_release_receipt IN ACCESS EXCLUSIVE MODE NOWAIT;
--> statement-breakpoint

-- drizzle/0064_mail_outbox_dispatch_binding.sql:74; actor-only change plus the preserved
-- release-marker cleanup repair for enforce_email_outbox_delivery_hold().
DO $mail_body_enforce_email_outbox_dispatch_binding$
DECLARE routine_oid pg_catalog.oid; prior_source pg_catalog.text;
        definition pg_catalog.text; candidate_source pg_catalog.text := $candidate_body$
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

  IF current_user IS DISTINCT FROM session_user
     OR session_user NOT IN ('learncoding_worker', 'learncoding_mail_worker') THEN
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
$candidate_body$;
BEGIN
  routine_oid := pg_catalog.to_regprocedure('public.enforce_email_outbox_dispatch_binding()');
  SELECT routine.prosrc, pg_catalog.pg_get_functiondef(routine.oid)
    INTO prior_source, definition FROM pg_catalog.pg_proc routine
   WHERE routine.oid=routine_oid AND routine.proowner='learncoding_owner'::pg_catalog.regrole
     AND routine.prosecdef=false AND routine.prokind='f'
     AND routine.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
     AND routine.proconfig=ARRAY['search_path=pg_catalog']::pg_catalog.text[]
     AND routine.provolatile='v' AND routine.proparallel='u'
     AND routine.proisstrict=false AND NOT routine.proleakproof
     AND routine.pronargdefaults=0 AND routine.proargdefaults IS NULL;
  IF prior_source IS NULL OR pg_catalog.encode(pg_catalog.sha256(
       pg_catalog.convert_to(prior_source,'UTF8')),'hex') <> 'e03d2be2455d53f9ddd0c0b7a8029efd07186a4d6804b86c2206b29031da7fdf' THEN
    RAISE EXCEPTION 'reviewed mail routine body mismatch: enforce_email_outbox_dispatch_binding';
  END IF;
  IF pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(candidate_source,'UTF8')),'hex')
       <> 'd665c8be3974d79b6acc0f99c3b92b716572ff05f54309a959ce24c5ba999233' THEN RAISE EXCEPTION 'mail candidate body mismatch'; END IF;
  IF pg_catalog.strpos(definition,prior_source)=0 THEN RAISE EXCEPTION 'mail definition source mismatch'; END IF;
  EXECUTE pg_catalog.replace(definition,prior_source,candidate_source);
END
$mail_body_enforce_email_outbox_dispatch_binding$;
--> statement-breakpoint

-- drizzle/0065_backup_status_mail_authority.sql:548; actor-only change plus the preserved
-- release-marker cleanup repair for enforce_email_outbox_delivery_hold().
DO $mail_body_backup_status_mail_authorized$
DECLARE routine_oid pg_catalog.oid; prior_source pg_catalog.text;
        definition pg_catalog.text; candidate_source pg_catalog.text := $candidate_body$
DECLARE
  authorized boolean := false;
  hinted_admin_id text;
  selected_operation_id uuid;
  current_authority_epoch uuid;
BEGIN
  IF session_user NOT IN ('learncoding_worker', 'learncoding_mail_worker')
     OR current_user <> 'learncoding_owner' THEN
    RAISE EXCEPTION 'backup status mail predicate caller is not authorized'
      USING ERRCODE = '42501';
  END IF;
  IF p_candidate_outbox_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT candidate.user_id, candidate.operation_id
    INTO hinted_admin_id, selected_operation_id
    FROM public.backup_status_mail_authority AS source
    JOIN public.email_outbox AS candidate
      ON candidate.id = source.outbox_id
   WHERE candidate.id = p_candidate_outbox_id
     AND source.outbox_id = candidate.id
     AND source.operation_id = candidate.operation_id;
  IF NOT FOUND OR hinted_admin_id IS NULL THEN
    RETURN false;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(
      'user-authority:' || hinted_admin_id
    )::pg_catalog.int8
  );

  PERFORM locked_recipient.id
    FROM public."user" AS locked_recipient
   WHERE locked_recipient.id = hinted_admin_id
   FOR SHARE OF locked_recipient;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  PERFORM locked_candidate.id
    FROM public.email_outbox AS locked_candidate
   WHERE locked_candidate.id = p_candidate_outbox_id
     AND locked_candidate.operation_id = selected_operation_id
     AND locked_candidate.user_id = hinted_admin_id
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

  RETURN coalesce(authorized, false);
END
$candidate_body$;
BEGIN
  routine_oid := pg_catalog.to_regprocedure('public.backup_status_mail_authorized(uuid)');
  SELECT routine.prosrc, pg_catalog.pg_get_functiondef(routine.oid)
    INTO prior_source, definition FROM pg_catalog.pg_proc routine
   WHERE routine.oid=routine_oid AND routine.proowner='learncoding_owner'::pg_catalog.regrole
     AND routine.prosecdef=true AND routine.prokind='f'
     AND routine.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
     AND routine.proconfig=ARRAY['search_path=pg_catalog']::pg_catalog.text[]
     AND routine.provolatile='v' AND routine.proparallel='u'
     AND routine.proisstrict=false AND NOT routine.proleakproof
     AND routine.pronargdefaults=0 AND routine.proargdefaults IS NULL;
  IF prior_source IS NULL OR pg_catalog.encode(pg_catalog.sha256(
       pg_catalog.convert_to(prior_source,'UTF8')),'hex') <> 'c947fcc0d019174fcb76c39d61fa736bd552dd6f2eeae6f46cfc772aa4dc95ae' THEN
    RAISE EXCEPTION 'reviewed mail routine body mismatch: backup_status_mail_authorized';
  END IF;
  IF pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(candidate_source,'UTF8')),'hex')
       <> '8a5306131ab339d40c9ce801ea5d41f2a85c87394b29231d34271f6273adf364' THEN RAISE EXCEPTION 'mail candidate body mismatch'; END IF;
  IF pg_catalog.strpos(definition,prior_source)=0 THEN RAISE EXCEPTION 'mail definition source mismatch'; END IF;
  EXECUTE pg_catalog.replace(definition,prior_source,candidate_source);
END
$mail_body_backup_status_mail_authorized$;
--> statement-breakpoint

-- drizzle/0066_mail_outbox_provider_correlation_evidence.sql:324; actor-only change plus the preserved
-- release-marker cleanup repair for enforce_email_outbox_delivery_hold().
DO $mail_body_enforce_email_outbox_provider_correlation_evidence$
DECLARE routine_oid pg_catalog.oid; prior_source pg_catalog.text;
        definition pg_catalog.text; candidate_source pg_catalog.text := $candidate_body$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.provider_correlation_version IS NOT NULL
       OR NEW.provider_evidence_version IS NOT NULL
       OR NEW.provider_evidence_sha256 IS NOT NULL THEN
      RAISE EXCEPTION
        'email outbox provider correlation evidence insert is invalid'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.provider_correlation_version
       IS NOT DISTINCT FROM NEW.provider_correlation_version
     AND OLD.provider_evidence_version
       IS NOT DISTINCT FROM NEW.provider_evidence_version
     AND OLD.provider_evidence_sha256
       IS NOT DISTINCT FROM NEW.provider_evidence_sha256 THEN
    IF OLD.provider_correlation_version IS NOT NULL
       OR OLD.provider_evidence_version IS NOT NULL
       OR OLD.provider_evidence_sha256 IS NOT NULL
       OR (
         OLD.provider_call_started
           IS NOT DISTINCT FROM NEW.provider_call_started
         AND OLD.adapter IS NOT DISTINCT FROM NEW.adapter
         AND OLD.provider_message_id
           IS NOT DISTINCT FROM NEW.provider_message_id
         AND OLD.dispatch_binding_version
           IS NOT DISTINCT FROM NEW.dispatch_binding_version
         AND OLD.dispatch_binding_sha256
           IS NOT DISTINCT FROM NEW.dispatch_binding_sha256
       ) THEN
      RETURN NEW;
    END IF;
  END IF;

  IF OLD.provider_correlation_version IS NOT NULL
     OR OLD.provider_evidence_version IS NOT NULL
     OR OLD.provider_evidence_sha256 IS NOT NULL THEN
    RAISE EXCEPTION
      'email outbox provider correlation evidence is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF current_user IS DISTINCT FROM session_user
     OR session_user NOT IN ('learncoding_worker', 'learncoding_mail_worker') THEN
    RAISE EXCEPTION
      'email outbox provider correlation evidence arm requires worker identity'
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
    AND OLD.provider_call_started IS NULL
    AND NEW.provider_call_started = pg_catalog.statement_timestamp()
    AND OLD.adapter IS NULL
    AND NEW.adapter IN ('gmail', 'console')
    AND OLD.dispatch_binding_version IS NULL
    AND OLD.dispatch_binding_sha256 IS NULL
    AND NEW.dispatch_binding_version IN ('gmail-raw-v1', 'console-json-v1')
    AND NEW.dispatch_binding_sha256 ~ '^[0-9a-f]{64}$'
    AND OLD.provider_message_id IS NULL
    AND NEW.provider_message_id IS NULL
    AND NEW.provider_correlation_version = 'opaque-sha256-v1'
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
    AND OLD.next_attempt_at IS NOT DISTINCT FROM NEW.next_attempt_at
    AND OLD.sent_at IS NULL
    AND NEW.sent_at IS NULL
    AND OLD.quarantined_at IS NULL
    AND NEW.quarantined_at IS NULL
    AND OLD.last_error_code IS NOT DISTINCT FROM NEW.last_error_code
    AND OLD.created_at IS NOT DISTINCT FROM NEW.created_at
    AND NEW.updated_at = pg_catalog.statement_timestamp()
  ) IS NOT TRUE THEN
    RAISE EXCEPTION
      'email outbox provider correlation evidence transition is invalid'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$candidate_body$;
BEGIN
  routine_oid := pg_catalog.to_regprocedure('public.enforce_email_outbox_provider_correlation_evidence()');
  SELECT routine.prosrc, pg_catalog.pg_get_functiondef(routine.oid)
    INTO prior_source, definition FROM pg_catalog.pg_proc routine
   WHERE routine.oid=routine_oid AND routine.proowner='learncoding_owner'::pg_catalog.regrole
     AND routine.prosecdef=false AND routine.prokind='f'
     AND routine.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
     AND routine.proconfig=ARRAY['search_path=pg_catalog']::pg_catalog.text[]
     AND routine.provolatile='v' AND routine.proparallel='u'
     AND routine.proisstrict=false AND NOT routine.proleakproof
     AND routine.pronargdefaults=0 AND routine.proargdefaults IS NULL;
  IF prior_source IS NULL OR pg_catalog.encode(pg_catalog.sha256(
       pg_catalog.convert_to(prior_source,'UTF8')),'hex') <> '62ff4885055979fb7eaf0fda3ae8170a14a430cb69d8f310e6aba742cf700e1a' THEN
    RAISE EXCEPTION 'reviewed mail routine body mismatch: enforce_email_outbox_provider_correlation_evidence';
  END IF;
  IF pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(candidate_source,'UTF8')),'hex')
       <> 'f2ff0f5ce06a001a9d5c425549679cc6cbb2ccc5e679f177833579b664ea96d3' THEN RAISE EXCEPTION 'mail candidate body mismatch'; END IF;
  IF pg_catalog.strpos(definition,prior_source)=0 THEN RAISE EXCEPTION 'mail definition source mismatch'; END IF;
  EXECUTE pg_catalog.replace(definition,prior_source,candidate_source);
END
$mail_body_enforce_email_outbox_provider_correlation_evidence$;
--> statement-breakpoint

-- drizzle/0069_mail_outbox_guarded_delivery_authority.sql:4115; actor-only change plus the preserved
-- release-marker cleanup repair for enforce_email_outbox_delivery_hold().
DO $mail_body_enforce_email_outbox_delivery_hold$
DECLARE routine_oid pg_catalog.oid; prior_source pg_catalog.text;
        definition pg_catalog.text; candidate_source pg_catalog.text := $candidate_body$
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
       'learncoding_owner',
       'learncoding_backup_reporter', 'learncoding_worker', 'learncoding_mail_worker'
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
     OR session_user NOT IN ('learncoding_worker', 'learncoding_mail_worker')
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
$candidate_body$;
BEGIN
  routine_oid := pg_catalog.to_regprocedure('public.enforce_email_outbox_delivery_hold()');
  SELECT routine.prosrc, pg_catalog.pg_get_functiondef(routine.oid)
    INTO prior_source, definition FROM pg_catalog.pg_proc routine
   WHERE routine.oid=routine_oid AND routine.proowner='learncoding_owner'::pg_catalog.regrole
     AND routine.prosecdef=true AND routine.prokind='f'
     AND routine.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
     AND routine.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
     AND routine.provolatile='v' AND routine.proparallel='u'
     AND routine.proisstrict=false AND NOT routine.proleakproof
     AND routine.pronargdefaults=0 AND routine.proargdefaults IS NULL;
  IF prior_source IS NULL OR pg_catalog.encode(pg_catalog.sha256(
       pg_catalog.convert_to(prior_source,'UTF8')),'hex') <> '7636ab37cc17692c0c31d160dc5d7f0421d6660c0da2dfb6a2d8cae4501ea4e1' THEN
    RAISE EXCEPTION 'reviewed mail routine body mismatch: enforce_email_outbox_delivery_hold';
  END IF;
  IF pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(candidate_source,'UTF8')),'hex')
       <> '7569495560ff7ddba9000cc75e2e0cf71cdb7642cf8607f9e610bad1f670d4f6' THEN RAISE EXCEPTION 'mail candidate body mismatch'; END IF;
  IF pg_catalog.strpos(definition,prior_source)=0 THEN RAISE EXCEPTION 'mail definition source mismatch'; END IF;
  EXECUTE pg_catalog.replace(definition,prior_source,candidate_source);
END
$mail_body_enforce_email_outbox_delivery_hold$;
--> statement-breakpoint

-- drizzle/0069_mail_outbox_guarded_delivery_authority.sql:2217; actor-only change plus the preserved
-- release-marker cleanup repair for enforce_email_outbox_delivery_hold().
DO $mail_body_enforce_email_outbox_delivery_release_insert_xid$
DECLARE routine_oid pg_catalog.oid; prior_source pg_catalog.text;
        definition pg_catalog.text; candidate_source pg_catalog.text := $candidate_body$
DECLARE
  current_system_identifier pg_catalog.int8;
BEGIN
  SELECT control.system_identifier
    INTO STRICT current_system_identifier
    FROM pg_catalog.pg_control_system() AS control;
  IF TG_OP = 'INSERT' THEN
    NEW.delivery_release_insert_xid := pg_catalog.pg_current_xact_id();
    NEW.delivery_release_insert_system_identifier :=
      current_system_identifier;
    RETURN NEW;
  END IF;

  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'email outbox created_at is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF ROW(
       NEW.delivery_release_insert_xid,
       NEW.delivery_release_insert_system_identifier
     ) IS NOT DISTINCT FROM ROW(
       OLD.delivery_release_insert_xid,
       OLD.delivery_release_insert_system_identifier
     )
  THEN
    RETURN NEW;
  END IF;

  IF current_user IS NOT DISTINCT FROM 'learncoding_owner'
     AND session_user IN (
       'learncoding_app', 'learncoding_worker',
       'learncoding_owner', 'learncoding_backup_reporter'
     , 'learncoding_mail_worker')
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
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'email outbox delivery release insert xid is immutable'
    USING ERRCODE = '23514';
END
$candidate_body$;
BEGIN
  routine_oid := pg_catalog.to_regprocedure('public.enforce_email_outbox_delivery_release_insert_xid()');
  SELECT routine.prosrc, pg_catalog.pg_get_functiondef(routine.oid)
    INTO prior_source, definition FROM pg_catalog.pg_proc routine
   WHERE routine.oid=routine_oid AND routine.proowner='learncoding_owner'::pg_catalog.regrole
     AND routine.prosecdef=true AND routine.prokind='f'
     AND routine.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
     AND routine.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
     AND routine.provolatile='v' AND routine.proparallel='u'
     AND routine.proisstrict=false AND NOT routine.proleakproof
     AND routine.pronargdefaults=0 AND routine.proargdefaults IS NULL;
  IF prior_source IS NULL OR pg_catalog.encode(pg_catalog.sha256(
       pg_catalog.convert_to(prior_source,'UTF8')),'hex') <> 'a76581c119a10ce8943cd7a60e674938d7163f8a3fe444e83f49751a7c116e46' THEN
    RAISE EXCEPTION 'reviewed mail routine body mismatch: enforce_email_outbox_delivery_release_insert_xid';
  END IF;
  IF pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(candidate_source,'UTF8')),'hex')
       <> '9eade96c7535c6a5ebfd0229557552b5b58815a69ab1b6ccdbea1ce32bd32ee8' THEN RAISE EXCEPTION 'mail candidate body mismatch'; END IF;
  IF pg_catalog.strpos(definition,prior_source)=0 THEN RAISE EXCEPTION 'mail definition source mismatch'; END IF;
  EXECUTE pg_catalog.replace(definition,prior_source,candidate_source);
END
$mail_body_enforce_email_outbox_delivery_release_insert_xid$;
--> statement-breakpoint

-- drizzle/0069_mail_outbox_guarded_delivery_authority.sql:2447; actor-only change plus the preserved
-- release-marker cleanup repair for enforce_email_outbox_delivery_hold().
DO $mail_body_enforce_mail_delivery_release_receipt_insert$
DECLARE routine_oid pg_catalog.oid; prior_source pg_catalog.text;
        definition pg_catalog.text; candidate_source pg_catalog.text := $candidate_body$
DECLARE
  candidate public.email_outbox%ROWTYPE;
  current_system_identifier pg_catalog.int8;
BEGIN
  IF current_user IS DISTINCT FROM 'learncoding_owner'
     OR session_user NOT IN (
       'learncoding_app',
       'learncoding_worker',
       'learncoding_owner',
       'learncoding_backup_reporter'
     , 'learncoding_mail_worker')
  THEN
    RAISE EXCEPTION 'mail delivery release receipt insert caller is invalid'
      USING ERRCODE = '42501';
  END IF;

  SELECT control.system_identifier
    INTO STRICT current_system_identifier
    FROM pg_catalog.pg_control_system() AS control;

  SELECT outbox.*
    INTO candidate
    FROM ONLY public.email_outbox AS outbox
   WHERE outbox.id = NEW.outbox_id
     AND outbox.operation_id = NEW.operation_id
   FOR SHARE;

  IF NOT FOUND
     OR candidate.delivery_release_insert_xid
          IS DISTINCT FROM pg_catalog.pg_current_xact_id()
     OR candidate.delivery_release_insert_system_identifier
          IS DISTINCT FROM current_system_identifier
     OR candidate.status IS DISTINCT FROM 'pending'
     OR candidate.attempt_count IS DISTINCT FROM 0
     OR candidate.claim_version IS DISTINCT FROM 0
     OR candidate.claim_token IS NOT NULL
     OR candidate.claim_owner IS NOT NULL
     OR candidate.lease_expires_at IS NOT NULL
     OR candidate.provider_call_started IS NOT NULL
     OR candidate.adapter IS NOT NULL
     OR candidate.dispatch_binding_version IS NOT NULL
     OR candidate.dispatch_binding_sha256 IS NOT NULL
     OR candidate.provider_correlation_version IS NOT NULL
     OR candidate.provider_evidence_version IS NOT NULL
     OR candidate.provider_evidence_sha256 IS NOT NULL
     OR candidate.provider_message_id IS NOT NULL
     OR candidate.provider_request_body_sha256 IS NOT NULL
     OR candidate.provider_request_body_length IS NOT NULL
     OR candidate.sent_at IS NOT NULL
     OR candidate.quarantined_at IS NOT NULL
     OR candidate.last_error_code IS NOT NULL
     OR candidate.idempotency_original_payload_sha256 IS DISTINCT FROM
          public.email_outbox_original_payload_sha256(
            candidate.user_id,
            candidate.to_email,
            candidate.template,
            candidate.template_version,
            candidate.variables
          )
     OR NOT pg_catalog.isfinite(candidate.created_at)
     OR NOT pg_catalog.isfinite(candidate.updated_at)
     OR NOT pg_catalog.isfinite(candidate.next_attempt_at)
     OR candidate.created_at IS DISTINCT FROM
          pg_catalog.transaction_timestamp()
     OR candidate.updated_at IS DISTINCT FROM
          pg_catalog.transaction_timestamp()
     OR candidate.next_attempt_at < pg_catalog.transaction_timestamp()
     OR candidate.next_attempt_at >
          pg_catalog.transaction_timestamp() + interval '5 minutes'
     OR candidate.delivery_hold_version IS DISTINCT FROM 'task7-v1'
     OR candidate.idempotency_authority_version NOT IN (
       'event-v1-native', 'event-v1-source-map'
     )
     OR (
       session_user = 'learncoding_backup_reporter'
       AND candidate.template IS DISTINCT FROM 'backup-status'
     )
  THEN
    RAISE EXCEPTION 'mail delivery release receipt insert state is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.outbox_id IS DISTINCT FROM candidate.id
     OR NEW.operation_id IS DISTINCT FROM candidate.operation_id
     OR NEW.idempotency_authority_version
          IS DISTINCT FROM candidate.idempotency_authority_version
     OR NEW.idempotency_authority_sha256
          IS DISTINCT FROM candidate.idempotency_authority_sha256
     OR NEW.idempotency_original_payload_sha256
          IS DISTINCT FROM candidate.idempotency_original_payload_sha256
     OR NEW.release_version IS DISTINCT FROM candidate.delivery_hold_version
     OR NEW.release_receipt_sha256 IS DISTINCT FROM
          public.mail_delivery_release_receipt_sha256(
            candidate.id,
            candidate.operation_id,
            candidate.idempotency_authority_version,
            candidate.idempotency_authority_sha256,
            candidate.idempotency_original_payload_sha256,
            candidate.delivery_hold_version
          )
     OR NOT EXISTS (
       SELECT 1
         FROM ONLY public.email_outbox_idempotency_authority AS authority
        WHERE authority.idempotency_sha256 =
                candidate.idempotency_authority_sha256
          AND authority.original_payload_sha256 =
                candidate.idempotency_original_payload_sha256
     )
  THEN
    RAISE EXCEPTION 'mail delivery release receipt identity is invalid'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$candidate_body$;
BEGIN
  routine_oid := pg_catalog.to_regprocedure('public.enforce_mail_delivery_release_receipt_insert()');
  SELECT routine.prosrc, pg_catalog.pg_get_functiondef(routine.oid)
    INTO prior_source, definition FROM pg_catalog.pg_proc routine
   WHERE routine.oid=routine_oid AND routine.proowner='learncoding_owner'::pg_catalog.regrole
     AND routine.prosecdef=false AND routine.prokind='f'
     AND routine.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
     AND routine.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
     AND routine.provolatile='v' AND routine.proparallel='u'
     AND routine.proisstrict=false AND NOT routine.proleakproof
     AND routine.pronargdefaults=0 AND routine.proargdefaults IS NULL;
  IF prior_source IS NULL OR pg_catalog.encode(pg_catalog.sha256(
       pg_catalog.convert_to(prior_source,'UTF8')),'hex') <> '5214d841459e6be0d0ab80d2a61299ddee7669d535814c287dfbc3b91c6b8225' THEN
    RAISE EXCEPTION 'reviewed mail routine body mismatch: enforce_mail_delivery_release_receipt_insert';
  END IF;
  IF pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(candidate_source,'UTF8')),'hex')
       <> '59fbe9a3962076192c68106d44c3d13cf46db5cd5be249b4c835fc1ac6c44f8b' THEN RAISE EXCEPTION 'mail candidate body mismatch'; END IF;
  IF pg_catalog.strpos(definition,prior_source)=0 THEN RAISE EXCEPTION 'mail definition source mismatch'; END IF;
  EXECUTE pg_catalog.replace(definition,prior_source,candidate_source);
END
$mail_body_enforce_mail_delivery_release_receipt_insert$;
--> statement-breakpoint

-- drizzle/0069_mail_outbox_guarded_delivery_authority.sql:2572; actor-only change plus the preserved
-- release-marker cleanup repair for enforce_email_outbox_delivery_hold().
DO $mail_body_release_email_outbox_delivery$
DECLARE routine_oid pg_catalog.oid; prior_source pg_catalog.text;
        definition pg_catalog.text; candidate_source pg_catalog.text := $candidate_body$
DECLARE
  candidate public.email_outbox%ROWTYPE;
  existing_receipt public.mail_delivery_release_receipt%ROWTYPE;
  issued_receipt public.mail_delivery_release_receipt%ROWTYPE;
  expected_receipt_sha256 pg_catalog.text;
  conflicting_receipts pg_catalog.int4;
  changed_rows pg_catalog.int4;
  current_system_identifier pg_catalog.int8;
BEGIN
  IF current_user IS DISTINCT FROM 'learncoding_owner'
     OR session_user NOT IN (
       'learncoding_app',
       'learncoding_worker',
       'learncoding_owner',
       'learncoding_backup_reporter'
     , 'learncoding_mail_worker')
  THEN
    RAISE EXCEPTION 'email outbox delivery release caller is invalid'
      USING ERRCODE = '42501';
  END IF;

  SELECT control.system_identifier
    INTO STRICT current_system_identifier
    FROM pg_catalog.pg_control_system() AS control;

  IF requested_outbox_id IS NULL
     OR requested_operation_id IS NULL
     OR requested_authority_sha256 IS NULL
     OR requested_authority_sha256 !~ '^[0-9a-f]{64}$'
     OR requested_original_payload_sha256 IS NULL
     OR requested_original_payload_sha256 !~ '^[0-9a-f]{64}$'
     OR requested_release_version IS DISTINCT FROM 'task7-v1'
  THEN
    RAISE EXCEPTION 'email outbox delivery release arguments are invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.count(*)::pg_catalog.int4
    INTO conflicting_receipts
    FROM ONLY public.mail_delivery_release_receipt AS release
   WHERE release.outbox_id = requested_outbox_id
      OR release.operation_id = requested_operation_id;

  IF conflicting_receipts > 0 THEN
    SELECT release.*
      INTO existing_receipt
      FROM ONLY public.mail_delivery_release_receipt AS release
     WHERE release.outbox_id = requested_outbox_id
       AND release.operation_id = requested_operation_id
       AND release.idempotency_authority_version IN (
         'event-v1-native', 'event-v1-source-map'
       )
       AND release.idempotency_authority_sha256 =
             requested_authority_sha256
       AND release.idempotency_original_payload_sha256 =
             requested_original_payload_sha256
       AND release.release_version = requested_release_version
       AND release.release_receipt_sha256 =
             public.mail_delivery_release_receipt_sha256(
               release.outbox_id,
               release.operation_id,
               release.idempotency_authority_version,
               release.idempotency_authority_sha256,
               release.idempotency_original_payload_sha256,
               release.release_version
             );

    IF conflicting_receipts <> 1 OR NOT FOUND THEN
      RAISE EXCEPTION 'email outbox delivery release receipt conflicts'
        USING ERRCODE = '23505';
    END IF;

    SELECT outbox.*
      INTO candidate
      FROM ONLY public.email_outbox AS outbox
     WHERE outbox.id = requested_outbox_id
       AND outbox.operation_id = requested_operation_id
     FOR SHARE;

    IF NOT FOUND
       OR candidate.delivery_release_insert_xid IS NOT NULL
       OR candidate.delivery_release_insert_system_identifier IS NOT NULL
       OR candidate.idempotency_authority_version
            IS DISTINCT FROM existing_receipt.idempotency_authority_version
       OR candidate.idempotency_authority_sha256
            IS DISTINCT FROM existing_receipt.idempotency_authority_sha256
       OR candidate.idempotency_original_payload_sha256
            IS DISTINCT FROM
                 existing_receipt.idempotency_original_payload_sha256
       OR candidate.delivery_hold_version
            IS DISTINCT FROM existing_receipt.release_version
    THEN
      RAISE EXCEPTION 'email outbox delivery release replay is invalid'
        USING ERRCODE = '23514';
    END IF;
    RETURN existing_receipt;

  END IF;

  SELECT outbox.*
    INTO candidate
    FROM ONLY public.email_outbox AS outbox
   WHERE outbox.id = requested_outbox_id
     AND outbox.operation_id = requested_operation_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'email outbox delivery release candidate is missing'
      USING ERRCODE = 'P0002';
  END IF;

  IF candidate.delivery_release_insert_xid
       IS DISTINCT FROM pg_catalog.pg_current_xact_id()
     OR candidate.delivery_release_insert_system_identifier
          IS DISTINCT FROM current_system_identifier
  THEN
    RAISE EXCEPTION 'email outbox delivery release is not first-transaction issuance'
      USING ERRCODE = '23514';
  END IF;

  IF candidate.idempotency_authority_version NOT IN (
       'event-v1-native', 'event-v1-source-map'
     )
     OR candidate.idempotency_authority_sha256
          IS DISTINCT FROM requested_authority_sha256
     OR candidate.idempotency_original_payload_sha256
          IS DISTINCT FROM requested_original_payload_sha256
     OR candidate.delivery_hold_version
          IS DISTINCT FROM requested_release_version
     OR candidate.delivery_hold_version IS DISTINCT FROM 'task7-v1'
  THEN
    RAISE EXCEPTION 'email outbox delivery release identity is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF candidate.status IS DISTINCT FROM 'pending'
     OR candidate.attempt_count IS DISTINCT FROM 0
     OR candidate.claim_version IS DISTINCT FROM 0
     OR candidate.claim_token IS NOT NULL
     OR candidate.claim_owner IS NOT NULL
     OR candidate.lease_expires_at IS NOT NULL
     OR candidate.provider_call_started IS NOT NULL
     OR candidate.adapter IS NOT NULL
     OR candidate.dispatch_binding_version IS NOT NULL
     OR candidate.dispatch_binding_sha256 IS NOT NULL
     OR candidate.provider_correlation_version IS NOT NULL
     OR candidate.provider_evidence_version IS NOT NULL
     OR candidate.provider_evidence_sha256 IS NOT NULL
     OR candidate.provider_message_id IS NOT NULL
     OR candidate.sent_at IS NOT NULL
     OR candidate.quarantined_at IS NOT NULL
     OR candidate.last_error_code IS NOT NULL
     OR candidate.provider_request_body_sha256 IS NOT NULL
     OR candidate.provider_request_body_length IS NOT NULL
     OR candidate.idempotency_original_payload_sha256 IS DISTINCT FROM
          public.email_outbox_original_payload_sha256(
            candidate.user_id,
            candidate.to_email,
            candidate.template,
            candidate.template_version,
            candidate.variables
          )
     OR NOT pg_catalog.isfinite(candidate.created_at)
     OR NOT pg_catalog.isfinite(candidate.updated_at)
     OR NOT pg_catalog.isfinite(candidate.next_attempt_at)
     OR candidate.created_at IS DISTINCT FROM
          pg_catalog.transaction_timestamp()
     OR candidate.updated_at IS DISTINCT FROM
          pg_catalog.transaction_timestamp()
     OR candidate.next_attempt_at < pg_catalog.transaction_timestamp()
     OR candidate.next_attempt_at >
          pg_catalog.transaction_timestamp() + interval '5 minutes'
  THEN
    RAISE EXCEPTION 'email outbox delivery release state is not pristine'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM ONLY public.email_outbox_idempotency_authority AS authority
     WHERE authority.idempotency_sha256 =
             candidate.idempotency_authority_sha256
       AND authority.original_payload_sha256 =
             candidate.idempotency_original_payload_sha256
  ) THEN
    RAISE EXCEPTION 'email outbox durable replay authority is missing'
      USING ERRCODE = '23503';
  END IF;

  expected_receipt_sha256 :=
    public.mail_delivery_release_receipt_sha256(
      candidate.id,
      candidate.operation_id,
      candidate.idempotency_authority_version,
      candidate.idempotency_authority_sha256,
      candidate.idempotency_original_payload_sha256,
      requested_release_version
    );

  INSERT INTO public.mail_delivery_release_receipt (
    outbox_id,
    operation_id,
    idempotency_authority_version,
    idempotency_authority_sha256,
    idempotency_original_payload_sha256,
    release_version,
    release_receipt_sha256,
    released_at
  ) VALUES (
    candidate.id,
    candidate.operation_id,
    candidate.idempotency_authority_version,
    candidate.idempotency_authority_sha256,
    candidate.idempotency_original_payload_sha256,
    requested_release_version,
    expected_receipt_sha256,
    pg_catalog.statement_timestamp()
  )
  ON CONFLICT DO NOTHING
  RETURNING * INTO issued_receipt;

  IF NOT FOUND THEN
    SELECT pg_catalog.count(*)::pg_catalog.int4
      INTO conflicting_receipts
      FROM ONLY public.mail_delivery_release_receipt AS release
     WHERE release.outbox_id = candidate.id
        OR release.operation_id = candidate.operation_id
        OR release.release_receipt_sha256 = expected_receipt_sha256;

    SELECT release.*
      INTO issued_receipt
      FROM ONLY public.mail_delivery_release_receipt AS release
     WHERE release.outbox_id = candidate.id
       AND release.operation_id = candidate.operation_id
       AND release.idempotency_authority_version =
             candidate.idempotency_authority_version
       AND release.idempotency_authority_sha256 =
             candidate.idempotency_authority_sha256
       AND release.idempotency_original_payload_sha256 =
             candidate.idempotency_original_payload_sha256
       AND release.release_version = requested_release_version
       AND release.release_receipt_sha256 = expected_receipt_sha256;

    IF conflicting_receipts <> 1 OR NOT FOUND THEN
      RAISE EXCEPTION 'email outbox delivery release receipt conflicts'
        USING ERRCODE = '23505';
    END IF;
  END IF;

  UPDATE ONLY public.email_outbox AS outbox
     SET delivery_release_insert_xid = NULL,
         delivery_release_insert_system_identifier = NULL
   WHERE outbox.id = candidate.id
     AND outbox.operation_id = candidate.operation_id
     AND outbox.delivery_release_insert_xid
           IS NOT DISTINCT FROM pg_catalog.pg_current_xact_id()
     AND outbox.delivery_release_insert_system_identifier
           IS NOT DISTINCT FROM current_system_identifier;

  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows <> 1 THEN
    RAISE EXCEPTION 'email outbox delivery release marker transition failed'
      USING ERRCODE = '23514';
  END IF;

  RETURN issued_receipt;
END
$candidate_body$;
BEGIN
  routine_oid := pg_catalog.to_regprocedure('public.release_email_outbox_delivery(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text)');
  SELECT routine.prosrc, pg_catalog.pg_get_functiondef(routine.oid)
    INTO prior_source, definition FROM pg_catalog.pg_proc routine
   WHERE routine.oid=routine_oid AND routine.proowner='learncoding_owner'::pg_catalog.regrole
     AND routine.prosecdef=true AND routine.prokind='f'
     AND routine.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
     AND routine.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
     AND routine.provolatile='v' AND routine.proparallel='u'
     AND routine.proisstrict=false AND NOT routine.proleakproof
     AND routine.pronargdefaults=0 AND routine.proargdefaults IS NULL;
  IF prior_source IS NULL OR pg_catalog.encode(pg_catalog.sha256(
       pg_catalog.convert_to(prior_source,'UTF8')),'hex') <> 'b90df49087aa1ca69e80fc18a4963d5fc724d91db8612b338c2d2b98f2a3db0f' THEN
    RAISE EXCEPTION 'reviewed mail routine body mismatch: release_email_outbox_delivery';
  END IF;
  IF pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(candidate_source,'UTF8')),'hex')
       <> '251f78108e9bb36431c346a3bd21622ea9918c5056ba869152d7a43d27b35e44' THEN RAISE EXCEPTION 'mail candidate body mismatch'; END IF;
  IF pg_catalog.strpos(definition,prior_source)=0 THEN RAISE EXCEPTION 'mail definition source mismatch'; END IF;
  EXECUTE pg_catalog.replace(definition,prior_source,candidate_source);
END
$mail_body_release_email_outbox_delivery$;
--> statement-breakpoint

-- drizzle/0069_mail_outbox_guarded_delivery_authority.sql:2996; actor-only change plus the preserved
-- release-marker cleanup repair for enforce_email_outbox_delivery_hold().
DO $mail_body_attest_email_outbox_delivery_release_lineage$
DECLARE routine_oid pg_catalog.oid; prior_source pg_catalog.text;
        definition pg_catalog.text; candidate_source pg_catalog.text := $candidate_body$
DECLARE
  journal_schema_oid pg_catalog.oid :=
    pg_catalog.to_regnamespace('drizzle');
  journal_oid pg_catalog.oid :=
    pg_catalog.to_regclass('drizzle.__drizzle_migrations');
  journal_sequence_oid pg_catalog.oid :=
    pg_catalog.to_regclass('drizzle.__drizzle_migrations_id_seq');
BEGIN
  IF current_user IS DISTINCT FROM 'learncoding_owner'
     OR session_user NOT IN (
       'learncoding_owner',
       'learncoding_worker'
     , 'learncoding_mail_worker')
  THEN
    RAISE EXCEPTION 'email outbox delivery lineage attestor caller is invalid'
      USING ERRCODE = '42501';
  END IF;

  IF candidate_migration_sha256 IS NULL
     OR candidate_migration_sha256 !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'email outbox delivery lineage candidate is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF journal_schema_oid IS NULL
     OR journal_oid IS NULL
     OR journal_sequence_oid IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_namespace AS namespace
         JOIN pg_catalog.pg_class AS journal
           ON journal.oid = journal_oid
          AND journal.relnamespace = namespace.oid
         JOIN pg_catalog.pg_class AS journal_sequence
           ON journal_sequence.oid = journal_sequence_oid
          AND journal_sequence.relnamespace = namespace.oid
        WHERE namespace.oid = journal_schema_oid
          AND namespace.nspname = 'drizzle'
          AND pg_catalog.pg_get_userbyid(namespace.nspowner) =
                'learncoding_owner'
          AND journal.relname = '__drizzle_migrations'
          AND journal.relkind = 'r'
          AND journal.relpersistence = 'p'
          AND pg_catalog.pg_get_userbyid(journal.relowner) =
                'learncoding_owner'
          AND journal.relnatts = 3
          AND NOT journal.relrowsecurity
          AND NOT journal.relforcerowsecurity
          AND NOT journal.relispartition
          AND journal.relpartbound IS NULL
          AND journal.reloftype = 0
          AND NOT journal.relhasrules
          AND NOT journal.relhastriggers
          AND NOT journal.relhassubclass
          AND journal.reloptions IS NULL
          AND journal.relreplident = 'd'
          AND journal.relam = (
            SELECT access_method.oid
              FROM pg_catalog.pg_am AS access_method
             WHERE access_method.amname = 'heap'
               AND access_method.amtype = 't'
          )
          AND journal_sequence.relname =
                '__drizzle_migrations_id_seq'
          AND journal_sequence.relkind = 'S'
          AND journal_sequence.relpersistence = 'p'
          AND pg_catalog.pg_get_userbyid(journal_sequence.relowner) =
                'learncoding_owner'
          AND journal_sequence.reloptions IS NULL
     )
     OR (
       SELECT COALESCE(
                pg_catalog.array_agg(
                  pg_catalog.concat_ws(
                    '|',
                    CASE
                      WHEN access.grantee = 0 THEN 'PUBLIC'
                      ELSE pg_catalog.pg_get_userbyid(access.grantee)
                    END,
                    CASE
                      WHEN access.grantor = 0 THEN 'PUBLIC'
                      ELSE pg_catalog.pg_get_userbyid(access.grantor)
                    END,
                    pg_catalog.lower(access.privilege_type),
                    access.is_grantable::pg_catalog.text
                  )
                  ORDER BY
                    CASE
                      WHEN access.grantee = 0 THEN 'PUBLIC'
                      ELSE pg_catalog.pg_get_userbyid(access.grantee)
                    END,
                    CASE
                      WHEN access.grantor = 0 THEN 'PUBLIC'
                      ELSE pg_catalog.pg_get_userbyid(access.grantor)
                    END,
                    pg_catalog.lower(access.privilege_type),
                    access.is_grantable
                ),
                ARRAY[]::pg_catalog.text[]
              )
         FROM pg_catalog.pg_namespace AS namespace
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(
             namespace.nspacl,
             pg_catalog.acldefault('n', namespace.nspowner)
           )
         ) AS access
        WHERE namespace.oid = journal_schema_oid
     ) IS DISTINCT FROM ARRAY[
       'learncoding_owner|learncoding_owner|create|false',
       'learncoding_owner|learncoding_owner|usage|false'
     ]::pg_catalog.text[]
     OR (
       SELECT COALESCE(
                pg_catalog.array_agg(
                  pg_catalog.concat_ws(
                    '|',
                    CASE
                      WHEN access.grantee = 0 THEN 'PUBLIC'
                      ELSE pg_catalog.pg_get_userbyid(access.grantee)
                    END,
                    CASE
                      WHEN access.grantor = 0 THEN 'PUBLIC'
                      ELSE pg_catalog.pg_get_userbyid(access.grantor)
                    END,
                    pg_catalog.lower(access.privilege_type),
                    access.is_grantable::pg_catalog.text
                  )
                  ORDER BY
                    CASE
                      WHEN access.grantee = 0 THEN 'PUBLIC'
                      ELSE pg_catalog.pg_get_userbyid(access.grantee)
                    END,
                    CASE
                      WHEN access.grantor = 0 THEN 'PUBLIC'
                      ELSE pg_catalog.pg_get_userbyid(access.grantor)
                    END,
                    pg_catalog.lower(access.privilege_type),
                    access.is_grantable
                ),
                ARRAY[]::pg_catalog.text[]
              )
         FROM pg_catalog.pg_class AS relation
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(
             relation.relacl,
             pg_catalog.acldefault('r', relation.relowner)
           )
         ) AS access
        WHERE relation.oid = journal_oid
     ) IS DISTINCT FROM ARRAY[
       'learncoding_owner|learncoding_owner|delete|false',
       'learncoding_owner|learncoding_owner|insert|false',
       'learncoding_owner|learncoding_owner|maintain|false',
       'learncoding_owner|learncoding_owner|references|false',
       'learncoding_owner|learncoding_owner|select|false',
       'learncoding_owner|learncoding_owner|trigger|false',
       'learncoding_owner|learncoding_owner|truncate|false',
       'learncoding_owner|learncoding_owner|update|false'
     ]::pg_catalog.text[]
     OR (
       SELECT COALESCE(
                pg_catalog.array_agg(
                  pg_catalog.concat_ws(
                    '|',
                    CASE
                      WHEN access.grantee = 0 THEN 'PUBLIC'
                      ELSE pg_catalog.pg_get_userbyid(access.grantee)
                    END,
                    CASE
                      WHEN access.grantor = 0 THEN 'PUBLIC'
                      ELSE pg_catalog.pg_get_userbyid(access.grantor)
                    END,
                    pg_catalog.lower(access.privilege_type),
                    access.is_grantable::pg_catalog.text
                  )
                  ORDER BY
                    CASE
                      WHEN access.grantee = 0 THEN 'PUBLIC'
                      ELSE pg_catalog.pg_get_userbyid(access.grantee)
                    END,
                    CASE
                      WHEN access.grantor = 0 THEN 'PUBLIC'
                      ELSE pg_catalog.pg_get_userbyid(access.grantor)
                    END,
                    pg_catalog.lower(access.privilege_type),
                    access.is_grantable
                ),
                ARRAY[]::pg_catalog.text[]
              )
         FROM pg_catalog.pg_class AS relation
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(
             relation.relacl,
             pg_catalog.acldefault('s', relation.relowner)
           )
         ) AS access
        WHERE relation.oid = journal_sequence_oid
     ) IS DISTINCT FROM ARRAY[
       'learncoding_owner|learncoding_owner|select|false',
       'learncoding_owner|learncoding_owner|update|false',
       'learncoding_owner|learncoding_owner|usage|false'
     ]::pg_catalog.text[]
     OR EXISTS (
       SELECT 1
         FROM (
           SELECT *
             FROM (VALUES
               (
                 'id'::pg_catalog.name,
                 1::pg_catalog.int2,
                 'pg_catalog.int4'::pg_catalog.regtype::pg_catalog.oid,
                 true,
                 true,
                 'nextval(''drizzle.__drizzle_migrations_id_seq''::regclass)'::pg_catalog.text,
                 0::pg_catalog.oid,
                 0::pg_catalog.int2,
                 ''::"char"
               ),
               (
                 'hash',
                 2::pg_catalog.int2,
                 'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
                 true,
                 false,
                 NULL::pg_catalog.text,
                 'pg_catalog."default"'::pg_catalog.regcollation::pg_catalog.oid,
                 0::pg_catalog.int2,
                 ''::"char"
               ),
               (
                 'created_at',
                 3::pg_catalog.int2,
                 'pg_catalog.int8'::pg_catalog.regtype::pg_catalog.oid,
                 false,
                 false,
                 NULL::pg_catalog.text,
                 0::pg_catalog.oid,
                 0::pg_catalog.int2,
                 ''::"char"
               )
             ) AS expected(
               column_name,
               attribute_number,
               type_oid,
               is_not_null,
               has_default,
               default_expression,
               collation_oid,
               dimensions,
               compression
             )
           EXCEPT ALL
           SELECT
             attribute.attname,
             attribute.attnum,
             attribute.atttypid,
             attribute.attnotnull,
             attribute.atthasdef,
             pg_catalog.pg_get_expr(
               default_row.adbin,
               default_row.adrelid
             ),
             attribute.attcollation,
             attribute.attndims,
             attribute.attcompression
             FROM pg_catalog.pg_attribute AS attribute
             LEFT JOIN pg_catalog.pg_attrdef AS default_row
               ON default_row.adrelid = attribute.attrelid
              AND default_row.adnum = attribute.attnum
            WHERE attribute.attrelid = journal_oid
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
              AND attribute.atttypmod = -1
              AND attribute.attidentity = ''
              AND attribute.attgenerated = ''
              AND NOT attribute.atthasmissing
              AND attribute.attmissingval IS NULL
              AND attribute.attislocal
              AND attribute.attinhcount = 0
              AND attribute.attoptions IS NULL
              AND attribute.attfdwoptions IS NULL
              AND attribute.attacl IS NULL
         ) AS missing_or_inexact_columns
     )
     OR (
       SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_attrdef AS default_row
        WHERE default_row.adrelid = journal_oid
          AND default_row.adnum = 1
          AND pg_catalog.pg_get_expr(
                default_row.adbin,
                default_row.adrelid
              ) =
                'nextval(''drizzle.__drizzle_migrations_id_seq''::regclass)'
     ) <> 1
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_constraint AS constraint_row
         JOIN pg_catalog.pg_index AS index_row
           ON index_row.indexrelid = constraint_row.conindid
          AND index_row.indrelid = constraint_row.conrelid
         JOIN pg_catalog.pg_class AS index_relation
           ON index_relation.oid = constraint_row.conindid
        WHERE constraint_row.conrelid = journal_oid
          AND constraint_row.connamespace = journal_schema_oid
          AND constraint_row.contype = 'p'
          AND constraint_row.conname = '__drizzle_migrations_pkey'
          AND constraint_row.conkey = ARRAY[1]::pg_catalog.int2[]
          AND constraint_row.confrelid = 0
          AND constraint_row.convalidated
          AND constraint_row.coninhcount = 0
          AND constraint_row.conparentid = 0
          AND NOT constraint_row.condeferrable
          AND NOT constraint_row.condeferred
          AND index_relation.relname = '__drizzle_migrations_pkey'
          AND index_relation.relnamespace = journal_schema_oid
          AND index_relation.relkind = 'i'
          AND index_relation.relpersistence = 'p'
          AND pg_catalog.pg_get_userbyid(index_relation.relowner) =
                'learncoding_owner'
          AND index_relation.relam = (
            SELECT access_method.oid
              FROM pg_catalog.pg_am AS access_method
             WHERE access_method.amname = 'btree'
               AND access_method.amtype = 'i'
          )
          AND index_relation.reloptions IS NULL
          AND index_row.indisunique
          AND index_row.indisprimary
          AND index_row.indisvalid
          AND index_row.indisready
          AND index_row.indislive
          AND index_row.indimmediate
          AND NOT index_row.indisclustered
          AND NOT index_row.indisreplident
          AND NOT index_row.indcheckxmin
          AND index_row.indnkeyatts = 1
          AND index_row.indnatts = 1
          AND ARRAY(
                SELECT key_column.attnum
                  FROM pg_catalog.unnest(
                         index_row.indkey::pg_catalog.int2[]
                       ) WITH ORDINALITY AS key_column(attnum, ordinality)
                 ORDER BY key_column.ordinality
              )::pg_catalog.int2[] = ARRAY[1]::pg_catalog.int2[]
          AND index_row.indexprs IS NULL
          AND index_row.indpred IS NULL
          AND pg_catalog.pg_get_constraintdef(
                constraint_row.oid,
                false
              ) = 'PRIMARY KEY (id)'
     )
     OR (
       SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.conrelid = journal_oid
          AND constraint_row.contype <> 'n'
     ) <> 1
     OR (
       pg_catalog.current_setting('server_version_num')::pg_catalog.int4 >=
         180000
       AND (
         (
           SELECT pg_catalog.count(DISTINCT constraint_row.conkey[1])
             FROM pg_catalog.pg_constraint AS constraint_row
            WHERE constraint_row.conrelid = journal_oid
              AND constraint_row.contype = 'n'
              AND pg_catalog.cardinality(constraint_row.conkey) = 1
              AND constraint_row.conkey[1] IN (1, 2)
              AND constraint_row.convalidated
              AND constraint_row.conislocal
              AND constraint_row.coninhcount = 0
              AND constraint_row.conparentid = 0
              AND NOT constraint_row.connoinherit
              AND NOT constraint_row.condeferrable
              AND NOT constraint_row.condeferred
              AND constraint_row.contypid = 0
              AND constraint_row.conindid = 0
              AND constraint_row.confrelid = 0
              AND COALESCE(
                    (
                      pg_catalog.to_jsonb(constraint_row)
                        ->> 'conenforced'
                    )::pg_catalog.bool,
                    true
                  )
         ) <> 2
         OR (
           SELECT pg_catalog.count(*)
             FROM pg_catalog.pg_constraint AS constraint_row
            WHERE constraint_row.conrelid = journal_oid
              AND constraint_row.contype = 'n'
         ) <> 2
       )
     )
     OR (
       pg_catalog.current_setting('server_version_num')::pg_catalog.int4 <
         180000
       AND EXISTS (
         SELECT 1
           FROM pg_catalog.pg_constraint AS constraint_row
          WHERE constraint_row.conrelid = journal_oid
            AND constraint_row.contype = 'n'
       )
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_sequence AS sequence_row
        WHERE sequence_row.seqrelid = journal_sequence_oid
          AND sequence_row.seqtypid =
                'pg_catalog.int4'::pg_catalog.regtype
          AND sequence_row.seqstart = 1
          AND sequence_row.seqincrement = 1
          AND sequence_row.seqmin = 1
          AND sequence_row.seqmax = 2147483647
          AND sequence_row.seqcache = 1
          AND NOT sequence_row.seqcycle
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_depend AS dependency
        WHERE dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
          AND dependency.objid = journal_sequence_oid
          AND dependency.objsubid = 0
          AND dependency.refclassid =
                'pg_catalog.pg_class'::pg_catalog.regclass
          AND dependency.refobjid = journal_oid
          AND dependency.refobjsubid = 1
          AND dependency.deptype = 'a'
     )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_policy AS policy
        WHERE policy.polrelid = journal_oid
     )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_rewrite AS rewrite
        WHERE rewrite.ev_class = journal_oid
     )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_inherits AS inheritance
        WHERE inheritance.inhrelid = journal_oid
           OR inheritance.inhparent = journal_oid
     )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_roles AS managed
         JOIN pg_catalog.pg_roles AS owner_role
           ON owner_role.rolname = 'learncoding_owner'
        WHERE managed.rolname IN (
                'learncoding_app',
                'learncoding_worker',
                'learncoding_ops',
                'learncoding_backup_reporter'
              )
          AND pg_catalog.pg_has_role(
                managed.oid,
                owner_role.oid,
                'MEMBER'
              )
     )
     OR EXISTS (
       SELECT 1
         FROM (VALUES
           (0::pg_catalog.oid),
           ((SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'learncoding_app')),
           ((SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'learncoding_worker')),
           ((SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'learncoding_ops')),
           ((SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'learncoding_backup_reporter'))
         ) AS principal(role_oid)
        WHERE pg_catalog.has_schema_privilege(
                principal.role_oid, journal_schema_oid, 'USAGE'
              )
           OR pg_catalog.has_schema_privilege(
                principal.role_oid, journal_schema_oid, 'CREATE'
              )
           OR pg_catalog.has_table_privilege(
                principal.role_oid, journal_oid, 'SELECT'
              )
           OR pg_catalog.has_table_privilege(
                principal.role_oid, journal_oid, 'INSERT'
              )
           OR pg_catalog.has_table_privilege(
                principal.role_oid, journal_oid, 'UPDATE'
              )
           OR pg_catalog.has_table_privilege(
                principal.role_oid, journal_oid, 'DELETE'
              )
           OR pg_catalog.has_table_privilege(
                principal.role_oid, journal_oid, 'TRUNCATE'
              )
           OR pg_catalog.has_table_privilege(
                principal.role_oid, journal_oid, 'REFERENCES'
              )
           OR pg_catalog.has_table_privilege(
                principal.role_oid, journal_oid, 'TRIGGER'
              )
           OR pg_catalog.has_table_privilege(
                principal.role_oid, journal_oid, 'MAINTAIN'
              )
           OR pg_catalog.has_any_column_privilege(
                principal.role_oid, journal_oid, 'SELECT'
              )
           OR pg_catalog.has_any_column_privilege(
                principal.role_oid, journal_oid, 'INSERT'
              )
           OR pg_catalog.has_any_column_privilege(
                principal.role_oid, journal_oid, 'UPDATE'
              )
           OR pg_catalog.has_any_column_privilege(
                principal.role_oid, journal_oid, 'REFERENCES'
              )
           OR pg_catalog.has_sequence_privilege(
                principal.role_oid, journal_sequence_oid, 'USAGE'
              )
           OR pg_catalog.has_sequence_privilege(
                principal.role_oid, journal_sequence_oid, 'SELECT'
              )
           OR pg_catalog.has_sequence_privilege(
                principal.role_oid, journal_sequence_oid, 'UPDATE'
              )
     )
  THEN
    RAISE EXCEPTION 'email outbox delivery lineage journal authority is invalid'
      USING ERRCODE = '23514';
  END IF;

  RETURN QUERY
  SELECT
    pg_catalog.count(*) FILTER (
      WHERE migration.created_at = 1784997273087
        AND migration.hash =
              '3d4962ed82c0209245ca7e0a0e9ea667001eab7ae864f89120894cc1fa915ec9'
    )::pg_catalog.int4,
    pg_catalog.count(*) FILTER (
      WHERE migration.created_at = 1785002172253
        AND migration.hash =
              'ccb3e093847fb875ded41ec0c36d0ff8405c04d1546ba9dd21696e86a73a6817'
    )::pg_catalog.int4,
    pg_catalog.count(*) FILTER (
      WHERE migration.created_at = 1785005772253
        AND migration.hash =
              '1b9e669025e2dccb54099fd99adbf26c8c6eccf5a10a39f3319772b2fdef4b0f'
    )::pg_catalog.int4,
    pg_catalog.count(*) FILTER (
      WHERE migration.created_at = 1785009372253
        AND migration.hash = candidate_migration_sha256
    )::pg_catalog.int4,
    pg_catalog.count(*) FILTER (
      WHERE migration.hash = candidate_migration_sha256
    )::pg_catalog.int4,
    pg_catalog.count(*) FILTER (
      WHERE migration.created_at >= 1784997273087
        AND migration.created_at <= 1785009372253
    )::pg_catalog.int4
    FROM ONLY drizzle.__drizzle_migrations AS migration;
END
$candidate_body$;
BEGIN
  routine_oid := pg_catalog.to_regprocedure('public.attest_email_outbox_delivery_release_lineage(pg_catalog.text)');
  SELECT routine.prosrc, pg_catalog.pg_get_functiondef(routine.oid)
    INTO prior_source, definition FROM pg_catalog.pg_proc routine
   WHERE routine.oid=routine_oid AND routine.proowner='learncoding_owner'::pg_catalog.regrole
     AND routine.prosecdef=true AND routine.prokind='f'
     AND routine.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
     AND routine.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
     AND routine.provolatile='s' AND routine.proparallel='u'
     AND routine.proisstrict=false AND NOT routine.proleakproof
     AND routine.pronargdefaults=0 AND routine.proargdefaults IS NULL;
  IF prior_source IS NULL OR pg_catalog.encode(pg_catalog.sha256(
       pg_catalog.convert_to(prior_source,'UTF8')),'hex') <> 'ef2bcb7f6642b27b9e30fd0c91a9d3d031f8d5a5e0f3647a9f7a57cab7bdc57a' THEN
    RAISE EXCEPTION 'reviewed mail routine body mismatch: attest_email_outbox_delivery_release_lineage';
  END IF;
  IF pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(candidate_source,'UTF8')),'hex')
       <> '4edfdc27d9f07ffbf27a12b99c6f55a6174041481612917422e6936dd8ef1884' THEN RAISE EXCEPTION 'mail candidate body mismatch'; END IF;
  IF pg_catalog.strpos(definition,prior_source)=0 THEN RAISE EXCEPTION 'mail definition source mismatch'; END IF;
  EXECUTE pg_catalog.replace(definition,prior_source,candidate_source);
END
$mail_body_attest_email_outbox_delivery_release_lineage$;
--> statement-breakpoint

-- drizzle/0069_mail_outbox_guarded_delivery_authority.sql:3960; actor-only change plus the preserved
-- release-marker cleanup repair for enforce_email_outbox_delivery_hold().
DO $mail_body_enforce_email_outbox_provider_request_body_immutable$
DECLARE routine_oid pg_catalog.oid; prior_source pg_catalog.text;
        definition pg_catalog.text; candidate_source pg_catalog.text := $candidate_body$
DECLARE
  guard_now pg_catalog.timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.provider_request_body_sha256 IS NOT NULL
       OR NEW.provider_request_body_length IS NOT NULL
    THEN
      RAISE EXCEPTION 'email outbox request-body binding is database-owned'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.provider_request_body_sha256
       IS NOT DISTINCT FROM NEW.provider_request_body_sha256
     AND OLD.provider_request_body_length
       IS NOT DISTINCT FROM NEW.provider_request_body_length
     AND OLD.provider_call_started
       IS NOT DISTINCT FROM NEW.provider_call_started
  THEN
    RETURN NEW;
  END IF;

  IF OLD.provider_request_body_sha256 IS NOT NULL
     OR OLD.provider_request_body_length IS NOT NULL
  THEN
    RAISE EXCEPTION 'email outbox request-body binding is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF current_user IS DISTINCT FROM 'learncoding_owner'
     OR session_user NOT IN ('learncoding_worker', 'learncoding_mail_worker')
  THEN
    RAISE EXCEPTION 'email outbox request-body arm requires worker identity'
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
    AND OLD.idempotency_authority_version
          IS NOT DISTINCT FROM NEW.idempotency_authority_version
    AND OLD.idempotency_authority_sha256
          IS NOT DISTINCT FROM NEW.idempotency_authority_sha256
    AND OLD.idempotency_original_payload_sha256
          IS NOT DISTINCT FROM NEW.idempotency_original_payload_sha256
    AND OLD.delivery_hold_version IS NOT DISTINCT FROM 'task7-v1'
    AND NEW.delivery_hold_version
          IS NOT DISTINCT FROM OLD.delivery_hold_version
    AND OLD.delivery_release_insert_xid IS NULL
    AND NEW.delivery_release_insert_xid IS NULL
    AND OLD.delivery_release_insert_system_identifier IS NULL
    AND NEW.delivery_release_insert_system_identifier IS NULL
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
    AND OLD.lease_expires_at > guard_now
    AND NEW.lease_expires_at
          >= guard_now + interval '15 seconds'
    AND NEW.lease_expires_at
          <= guard_now + interval '300 seconds'
    AND OLD.provider_call_started IS NULL
    AND NEW.provider_call_started = pg_catalog.statement_timestamp()
    AND OLD.adapter IS NULL
    AND NEW.adapter IN ('gmail', 'console')
    AND OLD.dispatch_binding_version IS NULL
    AND OLD.dispatch_binding_sha256 IS NULL
    AND NEW.dispatch_binding_version IN (
      'gmail-raw-v1', 'console-json-v1'
    )
    AND NEW.dispatch_binding_sha256 ~ '^[0-9a-f]{64}$'
    AND OLD.provider_correlation_version IS NULL
    AND NEW.provider_correlation_version = 'opaque-sha256-v1'
    AND OLD.provider_evidence_version IS NULL
    AND OLD.provider_evidence_sha256 IS NULL
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
    AND OLD.provider_message_id IS NULL
    AND NEW.provider_message_id IS NULL
    AND NEW.provider_request_body_sha256 ~ '^[0-9a-f]{64}$'
    AND NEW.provider_request_body_length >= 0
    AND NEW.provider_request_body_length <= 9007199254740991
    AND OLD.next_attempt_at IS NOT DISTINCT FROM NEW.next_attempt_at
    AND OLD.sent_at IS NULL
    AND NEW.sent_at IS NULL
    AND OLD.quarantined_at IS NULL
    AND NEW.quarantined_at IS NULL
    AND OLD.last_error_code IS NOT DISTINCT FROM NEW.last_error_code
    AND OLD.created_at IS NOT DISTINCT FROM NEW.created_at
    AND NEW.updated_at = pg_catalog.statement_timestamp()
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
  ) IS NOT TRUE THEN
    RAISE EXCEPTION 'email outbox request-body arm transition is invalid'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$candidate_body$;
BEGIN
  routine_oid := pg_catalog.to_regprocedure('public.enforce_email_outbox_provider_request_body_immutable()');
  SELECT routine.prosrc, pg_catalog.pg_get_functiondef(routine.oid)
    INTO prior_source, definition FROM pg_catalog.pg_proc routine
   WHERE routine.oid=routine_oid AND routine.proowner='learncoding_owner'::pg_catalog.regrole
     AND routine.prosecdef=true AND routine.prokind='f'
     AND routine.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
     AND routine.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
     AND routine.provolatile='v' AND routine.proparallel='u'
     AND routine.proisstrict=false AND NOT routine.proleakproof
     AND routine.pronargdefaults=0 AND routine.proargdefaults IS NULL;
  IF prior_source IS NULL OR pg_catalog.encode(pg_catalog.sha256(
       pg_catalog.convert_to(prior_source,'UTF8')),'hex') <> 'a7a9a6c120a0e32410e620bb745d65b53d0d0b8429467faf74e8c62c08cc5b5f' THEN
    RAISE EXCEPTION 'reviewed mail routine body mismatch: enforce_email_outbox_provider_request_body_immutable';
  END IF;
  IF pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(candidate_source,'UTF8')),'hex')
       <> '28371928ffa89f2fc77f1a19baf3c6980ba824fbea1d8352aa664a38e57d96d3' THEN RAISE EXCEPTION 'mail candidate body mismatch'; END IF;
  IF pg_catalog.strpos(definition,prior_source)=0 THEN RAISE EXCEPTION 'mail definition source mismatch'; END IF;
  EXECUTE pg_catalog.replace(definition,prior_source,candidate_source);
END
$mail_body_enforce_email_outbox_provider_request_body_immutable$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO learncoding_mail_worker;
--> statement-breakpoint

GRANT SELECT ("id", "user_id", "to_email", "template", "template_version", "variables", "idempotency_key", "operation_id", "delivery_scope_key", "status", "attempt_count", "claim_token", "claim_owner", "claim_version", "lease_expires_at", "provider_call_started", "provider_request_body_sha256", "provider_request_body_length", "adapter", "provider_message_id", "next_attempt_at", "sent_at", "quarantined_at", "last_error_code", "created_at", "updated_at", "dispatch_binding_version", "dispatch_binding_sha256", "provider_correlation_version", "provider_evidence_version", "provider_evidence_sha256", "idempotency_authority_version", "idempotency_authority_sha256", "idempotency_original_payload_sha256", "delivery_hold_version") ON public."email_outbox" TO learncoding_mail_worker;
--> statement-breakpoint

GRANT INSERT ("operation_id", "user_id", "delivery_scope_key", "to_email", "template", "template_version", "variables", "idempotency_key", "idempotency_authority_version", "status", "next_attempt_at") ON public."email_outbox" TO learncoding_mail_worker;
--> statement-breakpoint

GRANT UPDATE ("status", "attempt_count", "claim_token", "claim_owner", "claim_version", "lease_expires_at", "provider_call_started", "provider_request_body_sha256", "provider_request_body_length", "adapter", "provider_message_id", "next_attempt_at", "sent_at", "quarantined_at", "last_error_code", "updated_at", "dispatch_binding_version", "dispatch_binding_sha256", "provider_correlation_version", "provider_evidence_version", "provider_evidence_sha256") ON public."email_outbox" TO learncoding_mail_worker;
--> statement-breakpoint

GRANT SELECT ("outbox_id", "operation_id", "idempotency_authority_version", "idempotency_authority_sha256", "idempotency_original_payload_sha256", "release_version", "release_receipt_sha256") ON public."mail_delivery_release_receipt" TO learncoding_mail_worker;
--> statement-breakpoint

GRANT SELECT ("banned", "created_at", "email", "email_verified", "id", "last_meaningful_activity_at", "name", "role", "status", "timezone") ON public."user" TO learncoding_mail_worker;
--> statement-breakpoint

GRANT SELECT ("onboarding_completed_at", "user_id") ON public."learner_profile" TO learncoding_mail_worker;
--> statement-breakpoint

GRANT SELECT ("challenge_enabled", "daily_study_enabled", "daily_study_minute", "goal_enabled", "inactivity_paused_until", "learning_email_enabled", "quiet_end_minute", "quiet_hours_enabled", "quiet_start_minute", "revision_enabled", "revision_minute", "timezone", "user_id", "weekly_summary_enabled") ON public."notification_preference" TO learncoding_mail_worker;
--> statement-breakpoint

GRANT SELECT ("created_at", "decision", "id", "occurred_at", "policy_version", "purpose", "user_id") ON public."consent_record" TO learncoding_mail_worker;
--> statement-breakpoint

GRANT SELECT ("admin_notice_queued_at", "closed_at", "eligible_at", "id", "last_activity_at", "learner_first_queued_at", "learner_second_queued_at", "policy_version", "reminder_sent_at", "second_eligible_at", "user_id") ON public."inactivity_episode" TO learncoding_mail_worker;
--> statement-breakpoint

GRANT SELECT ("dispatched_at", "evidence", "id", "kind", "local_period_key", "scheduled_for", "timezone", "user_id") ON public."smart_reminder_dispatch" TO learncoding_mail_worker;
--> statement-breakpoint

GRANT SELECT ("due_at", "enrollment_id", "status") ON public."review_schedule" TO learncoding_mail_worker;
--> statement-breakpoint

GRANT SELECT ("id", "status", "user_id") ON public."enrollment" TO learncoding_mail_worker;
--> statement-breakpoint

GRANT SELECT ("battle_id", "user_id") ON public."coding_battle_participant" TO learncoding_mail_worker;
--> statement-breakpoint

GRANT SELECT ("id", "starts_at", "status") ON public."coding_battle" TO learncoding_mail_worker;
--> statement-breakpoint

GRANT SELECT ("adult_confirmed_at", "decided_at", "decided_by", "decision_reason", "email", "id", "name", "status") ON public."access_request" TO learncoding_mail_worker;
--> statement-breakpoint

GRANT SELECT ("access_request_id", "consumed_at", "created_by", "email", "expires_at", "id", "token_hash") ON public."invitation" TO learncoding_mail_worker;
--> statement-breakpoint

GRANT SELECT ("id", "primary_deletion_completed_at", "report", "user_id") ON public."account_deletion_tombstone" TO learncoding_mail_worker;
--> statement-breakpoint

GRANT SELECT ("completed_at", "id", "operation", "report", "status", "target_user_id") ON public."data_lifecycle_run" TO learncoding_mail_worker;
--> statement-breakpoint

GRANT SELECT ("expires_at", "id", "identifier", "value") ON public."verification" TO learncoding_mail_worker;
--> statement-breakpoint

GRANT SELECT ("expires_at", "id", "revoked_at", "user_id") ON public."session" TO learncoding_mail_worker;
--> statement-breakpoint

GRANT SELECT ("consumed_at", "expires_at", "id", "proof_hash", "session_id", "user_id") ON public."lost_device_proof" TO learncoding_mail_worker;
--> statement-breakpoint

GRANT SELECT ("id", "status", "user_id") ON public."session_revocation_request" TO learncoding_mail_worker;
--> statement-breakpoint

GRANT INSERT ("user_id", "last_activity_at", "eligible_at", "second_eligible_at", "opened_at", "policy_version", "created_at", "updated_at") ON public."inactivity_episode" TO learncoding_mail_worker;
--> statement-breakpoint

GRANT UPDATE ("closed_at", "updated_at", "learner_first_queued_at", "reminder_sent_at", "admin_notice_queued_at", "learner_second_queued_at") ON public."inactivity_episode" TO learncoding_mail_worker;
--> statement-breakpoint

GRANT INSERT ("user_id", "kind", "local_period_key", "timezone", "evidence", "scheduled_for", "dispatched_at") ON public."smart_reminder_dispatch" TO learncoding_mail_worker;
--> statement-breakpoint

GRANT INSERT ("user_id", "type", "title", "body", "action_url", "created_at") ON public."notification" TO learncoding_mail_worker;
--> statement-breakpoint

-- Bounded row-lock bridge. Source authority predicates must be re-read in
-- a fresh READ COMMITTED statement after all required locks are held, in the
-- existing account/preference/source lock order, before provider dispatch.
-- This routine cannot write source rows or access an arbitrary relation.
CREATE FUNCTION public.mail_worker_lock_source_v1(
  source_kind pg_catalog.text, source_id pg_catalog.text, lock_mode pg_catalog.text
) RETURNS pg_catalog.bool
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $mail_lock_source$
DECLARE relation_sql pg_catalog.text; key_sql pg_catalog.text; key_type_sql pg_catalog.text;
        clause_sql pg_catalog.text; locked_id pg_catalog.text;
BEGIN
  IF session_user IS DISTINCT FROM 'learncoding_mail_worker' OR current_user IS DISTINCT FROM 'learncoding_owner'
    THEN RAISE EXCEPTION 'mail source lock caller is not authorized' USING ERRCODE='42501'; END IF;
  IF source_id IS NULL OR pg_catalog.length(source_id) NOT BETWEEN 1 AND 256
     OR lock_mode IS NULL OR lock_mode NOT IN ('share','update') THEN
    RAISE EXCEPTION 'invalid bounded mail lock request' USING ERRCODE='22023';
  END IF;
  CASE source_kind
    WHEN 'user' THEN relation_sql := 'public."user"'; key_sql := 'id'; key_type_sql := 'pg_catalog.text';
    WHEN 'notification_preference' THEN relation_sql := 'public."notification_preference"'; key_sql := 'user_id'; key_type_sql := 'pg_catalog.text';
    WHEN 'access_request' THEN relation_sql := 'public."access_request"'; key_sql := 'id'; key_type_sql := 'pg_catalog.uuid';
    WHEN 'invitation' THEN relation_sql := 'public."invitation"'; key_sql := 'id'; key_type_sql := 'pg_catalog.uuid';
    WHEN 'verification' THEN relation_sql := 'public."verification"'; key_sql := 'id'; key_type_sql := 'pg_catalog.text';
    WHEN 'lost_device_proof' THEN relation_sql := 'public."lost_device_proof"'; key_sql := 'id'; key_type_sql := 'pg_catalog.uuid';
    WHEN 'session' THEN relation_sql := 'public."session"'; key_sql := 'id'; key_type_sql := 'pg_catalog.text';
    WHEN 'session_revocation_request' THEN relation_sql := 'public."session_revocation_request"'; key_sql := 'id'; key_type_sql := 'pg_catalog.uuid';
    WHEN 'inactivity_episode' THEN relation_sql := 'public."inactivity_episode"'; key_sql := 'id'; key_type_sql := 'pg_catalog.uuid';
    WHEN 'smart_reminder_dispatch' THEN relation_sql := 'public."smart_reminder_dispatch"'; key_sql := 'id'; key_type_sql := 'pg_catalog.uuid';
    ELSE RAISE EXCEPTION 'mail source relation is not allowed' USING ERRCODE='42501';
  END CASE;
  IF lock_mode='update' AND source_kind NOT IN ('user','notification_preference') THEN
    RAISE EXCEPTION 'mail source update lock is not allowed' USING ERRCODE='42501';
  END IF;
  clause_sql := CASE WHEN lock_mode='share' THEN 'FOR SHARE' ELSE 'FOR UPDATE' END;
  EXECUTE pg_catalog.format('SELECT %I::text FROM ONLY %s WHERE %I=$1::%s %s',
    key_sql,relation_sql,key_sql,key_type_sql,clause_sql) INTO locked_id USING source_id;
  RETURN locked_id IS NOT NULL;
END
$mail_lock_source$;
REVOKE ALL ON FUNCTION public.mail_worker_lock_source_v1(text,text,text)
 FROM PUBLIC,learncoding_app,learncoding_worker,learncoding_ops,learncoding_migrator,learncoding_backup_reporter;
GRANT EXECUTE ON FUNCTION public.mail_worker_lock_source_v1(text,text,text) TO learncoding_mail_worker;
--> statement-breakpoint

-- Exact delegation keeps the original routine ACL/catalog contract intact.
CREATE FUNCTION public.mail_worker_mail_delivery_release_receipt_sha256(arg1 pg_catalog.uuid, arg2 pg_catalog.uuid, arg3 pg_catalog.text, arg4 pg_catalog.text, arg5 pg_catalog.text, arg6 pg_catalog.text) RETURNS pg_catalog.text
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $mail_wrapper$
BEGIN
  IF session_user IS DISTINCT FROM 'learncoding_mail_worker' OR current_user IS DISTINCT FROM 'learncoding_owner'
    THEN RAISE EXCEPTION 'mail delegation caller is not authorized' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.email_outbox AS outbox
    WHERE outbox.id = arg1 AND outbox.operation_id = arg2
      AND outbox.idempotency_authority_version = arg3
      AND outbox.idempotency_authority_sha256 = arg4
      AND outbox.idempotency_original_payload_sha256 = arg5
      AND outbox.delivery_hold_version = arg6
      AND outbox.delivery_release_insert_xid IS NULL
      AND outbox.delivery_release_insert_system_identifier IS NULL
  ) THEN RETURN NULL; END IF;
  RETURN public.mail_delivery_release_receipt_sha256(arg1, arg2, arg3, arg4, arg5, arg6);
END
$mail_wrapper$;
REVOKE ALL ON FUNCTION public.mail_worker_mail_delivery_release_receipt_sha256(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text)
 FROM PUBLIC,learncoding_app,learncoding_worker,learncoding_ops,learncoding_migrator,learncoding_backup_reporter;
GRANT EXECUTE ON FUNCTION public.mail_worker_mail_delivery_release_receipt_sha256(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text) TO learncoding_mail_worker;
--> statement-breakpoint

-- Exact delegation keeps the original routine ACL/catalog contract intact.
CREATE FUNCTION public.mail_worker_backup_status_mail_authorized(arg1 uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $mail_wrapper$
BEGIN
  IF session_user IS DISTINCT FROM 'learncoding_mail_worker' OR current_user IS DISTINCT FROM 'learncoding_owner'
    THEN RAISE EXCEPTION 'mail delegation caller is not authorized' USING ERRCODE='42501'; END IF;
  RETURN public.backup_status_mail_authorized(arg1);
END
$mail_wrapper$;
REVOKE ALL ON FUNCTION public.mail_worker_backup_status_mail_authorized(uuid)
 FROM PUBLIC,learncoding_app,learncoding_worker,learncoding_ops,learncoding_migrator,learncoding_backup_reporter;
GRANT EXECUTE ON FUNCTION public.mail_worker_backup_status_mail_authorized(uuid) TO learncoding_mail_worker;
--> statement-breakpoint

-- Exact delegation keeps the original routine ACL/catalog contract intact.
CREATE FUNCTION public.mail_worker_attest_email_outbox_delivery_release_lineage(arg1 pg_catalog.text) RETURNS TABLE (
  phase_0066_count pg_catalog.int4,
  phase_0067_count pg_catalog.int4,
  phase_0068_count pg_catalog.int4,
  phase_0069_count pg_catalog.int4,
  candidate_hash_count pg_catalog.int4,
  lineage_window_count pg_catalog.int4
)
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $mail_wrapper$
BEGIN
  IF session_user IS DISTINCT FROM 'learncoding_mail_worker' OR current_user IS DISTINCT FROM 'learncoding_owner'
    THEN RAISE EXCEPTION 'mail delegation caller is not authorized' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT * FROM public.attest_email_outbox_delivery_release_lineage(arg1);
END
$mail_wrapper$;
REVOKE ALL ON FUNCTION public.mail_worker_attest_email_outbox_delivery_release_lineage(pg_catalog.text)
 FROM PUBLIC,learncoding_app,learncoding_worker,learncoding_ops,learncoding_migrator,learncoding_backup_reporter;
GRANT EXECUTE ON FUNCTION public.mail_worker_attest_email_outbox_delivery_release_lineage(pg_catalog.text) TO learncoding_mail_worker;
--> statement-breakpoint

-- Exact delegation keeps the original routine ACL/catalog contract intact.
CREATE FUNCTION public.mail_worker_release_email_outbox_delivery(arg1 pg_catalog.uuid, arg2 pg_catalog.uuid, arg3 pg_catalog.text, arg4 pg_catalog.text, arg5 pg_catalog.text) RETURNS TABLE(outbox_id pg_catalog.uuid, operation_id pg_catalog.uuid)
LANGUAGE plpgsql VOLATILE PARALLEL UNSAFE SECURITY DEFINER
SET search_path=pg_catalog,pg_temp
AS $mail_wrapper$
BEGIN
  IF session_user IS DISTINCT FROM 'learncoding_mail_worker' OR current_user IS DISTINCT FROM 'learncoding_owner'
    THEN RAISE EXCEPTION 'mail delegation caller is not authorized' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT released.outbox_id, released.operation_id FROM public.release_email_outbox_delivery(arg1, arg2, arg3, arg4, arg5) AS released;
END
$mail_wrapper$;
REVOKE ALL ON FUNCTION public.mail_worker_release_email_outbox_delivery(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text)
 FROM PUBLIC,learncoding_app,learncoding_worker,learncoding_ops,learncoding_migrator,learncoding_backup_reporter;
GRANT EXECUTE ON FUNCTION public.mail_worker_release_email_outbox_delivery(pg_catalog.uuid,pg_catalog.uuid,pg_catalog.text,pg_catalog.text,pg_catalog.text) TO learncoding_mail_worker;
--> statement-breakpoint

-- No grant on drizzle, owner-role membership, source UPDATE, DELETE, TRUNCATE,
-- arbitrary routines, unrelated tables, or future-object default ACLs.
-- The exact 0074 capability verifier must run before this login is activated.
DO $mail_role_postflight_0074$
BEGIN
  IF pg_catalog.pg_has_role('learncoding_mail_worker','learncoding_owner','MEMBER')
     OR pg_catalog.has_schema_privilege('learncoding_mail_worker','public','CREATE')
     OR pg_catalog.has_schema_privilege('learncoding_mail_worker','drizzle','USAGE') THEN
    RAISE EXCEPTION 'mail role administrative boundary mismatch';
  END IF;
END
$mail_role_postflight_0074$;
