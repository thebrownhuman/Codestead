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
CREATE OR REPLACE FUNCTION "public"."enforce_email_outbox_dispatch_binding"()
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
DO $codestead_dispatch_binding_acl_scrub$
DECLARE
  routine_row record;
  relation_identity text;
  acl_grantee record;
  column_row record;
  grantee_sql text;
BEGIN
  SELECT pg_catalog.format(
           '%I.%I(%s)',
           namespace.nspname,
           routine.proname,
           pg_catalog.pg_get_function_identity_arguments(routine.oid)
         ) AS function_identity
    INTO STRICT routine_row
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
   WHERE routine.oid =
     'public.enforce_email_outbox_dispatch_binding()'::pg_catalog.regprocedure;

  SELECT pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
    INTO STRICT relation_identity
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
   WHERE relation.oid = 'public.email_outbox'::pg_catalog.regclass;

  FOR acl_grantee IN
    SELECT DISTINCT access.grantee
      FROM pg_catalog.pg_proc AS routine
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          routine.proacl,
          pg_catalog.acldefault('f', routine.proowner)
        )
      ) AS access
     WHERE routine.oid =
       'public.enforce_email_outbox_dispatch_binding()'::pg_catalog.regprocedure
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
      routine_row.function_identity,
      grantee_sql
    );
  END LOOP;

  FOR column_row IN
    SELECT attribute.attname, attribute.attacl
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = 'public.email_outbox'::pg_catalog.regclass
       AND attribute.attname IN (
         'dispatch_binding_version',
         'dispatch_binding_sha256'
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
$codestead_dispatch_binding_acl_scrub$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."enforce_email_outbox_dispatch_binding"()
  TO learncoding_owner;--> statement-breakpoint
CREATE TRIGGER "email_outbox_dispatch_binding_guard"
BEFORE INSERT OR UPDATE ON public.email_outbox
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_email_outbox_dispatch_binding"();--> statement-breakpoint
GRANT UPDATE (
  dispatch_binding_version,
  dispatch_binding_sha256
) ON TABLE public.email_outbox TO learncoding_worker;--> statement-breakpoint
DO $codestead_dispatch_binding_acl_verify$
DECLARE
  routine_row record;
  function_acl text[];
  column_row record;
  column_acl text[];
  checked_columns integer := 0;
BEGIN
  SELECT pg_catalog.pg_get_userbyid(routine.proowner) AS owner_name,
         routine.proowner,
         routine.proacl,
         routine.prosecdef,
         routine.proconfig,
         pg_catalog.encode(
           pg_catalog.sha256(
             pg_catalog.convert_to(routine.prosrc, 'UTF8')
           ),
           'hex'
         ) AS body_sha256
    INTO STRICT routine_row
    FROM pg_catalog.pg_proc AS routine
   WHERE routine.oid =
     'public.enforce_email_outbox_dispatch_binding()'::pg_catalog.regprocedure;

  SELECT pg_catalog.array_agg(
           pg_catalog.format(
             '%s|%s|%s',
             CASE WHEN access.grantee = 0
               THEN 'PUBLIC'
               ELSE pg_catalog.pg_get_userbyid(access.grantee)
             END,
             pg_catalog.lower(access.privilege_type),
             access.is_grantable::text
           )
           ORDER BY access.grantor, access.grantee,
                    access.privilege_type, access.is_grantable
         )
    INTO function_acl
    FROM pg_catalog.aclexplode(
      COALESCE(
        routine_row.proacl,
        pg_catalog.acldefault('f', routine_row.proowner)
      )
    ) AS access;

  IF routine_row.owner_name IS DISTINCT FROM 'learncoding_owner'
     OR routine_row.prosecdef
     OR routine_row.proconfig IS DISTINCT FROM
          ARRAY['search_path=pg_catalog']::text[]
     OR routine_row.body_sha256 IS DISTINCT FROM
          'e03d2be2455d53f9ddd0c0b7a8029efd07186a4d6804b86c2206b29031da7fdf'
     OR function_acl IS DISTINCT FROM
          ARRAY['learncoding_owner|execute|false']::text[] THEN
    RAISE EXCEPTION 'email outbox dispatch binding function ACL contract failed'
      USING ERRCODE = '42501';
  END IF;

  FOR column_row IN
    SELECT attribute.attname, attribute.attacl
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = 'public.email_outbox'::pg_catalog.regclass
       AND attribute.attname IN (
         'dispatch_binding_version',
         'dispatch_binding_sha256'
       )
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
     ORDER BY attribute.attnum
  LOOP
    checked_columns := checked_columns + 1;
    SELECT pg_catalog.array_agg(
             pg_catalog.format(
               '%s|%s|%s',
               CASE WHEN access.grantee = 0
                 THEN 'PUBLIC'
                 ELSE pg_catalog.pg_get_userbyid(access.grantee)
               END,
               pg_catalog.lower(access.privilege_type),
               access.is_grantable::text
             )
             ORDER BY access.grantor, access.grantee,
                      access.privilege_type, access.is_grantable
           )
      INTO column_acl
      FROM pg_catalog.aclexplode(column_row.attacl) AS access;

    IF column_acl IS DISTINCT FROM
         ARRAY['learncoding_worker|update|false']::text[] THEN
      RAISE EXCEPTION
        'email outbox dispatch binding column ACL contract failed for %',
        column_row.attname
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  IF checked_columns <> 2 THEN
    RAISE EXCEPTION 'email outbox dispatch binding columns are incomplete'
      USING ERRCODE = '42703';
  END IF;
END
$codestead_dispatch_binding_acl_verify$;
