LOCK TABLE public.email_outbox IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
DO $preflight$
BEGIN
  IF NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc routine
         JOIN pg_catalog.pg_language language
           ON language.oid = routine.prolang
        WHERE routine.oid = pg_catalog.to_regprocedure(
                'public.enforce_email_outbox_dispatch_binding()'
              )
          AND pg_catalog.pg_get_userbyid(routine.proowner) =
                'learncoding_owner'
          AND NOT routine.prosecdef
          AND routine.proconfig IS NOT DISTINCT FROM
                ARRAY['search_path=pg_catalog']::text[]
          AND language.lanname = 'plpgsql'
          AND routine.prokind = 'f'
          AND routine.provolatile = 'v'
          AND NOT routine.proisstrict
          AND routine.proparallel = 'u'
          AND NOT routine.proleakproof
          AND routine.pronargs = 0
          AND routine.pronargdefaults = 0
          AND routine.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
          AND NOT routine.proretset
          AND routine.provariadic = 0
          AND pg_catalog.encode(
                pg_catalog.sha256(
                  pg_catalog.convert_to(routine.prosrc, 'UTF8')
                ),
                'hex'
              ) =
                'e03d2be2455d53f9ddd0c0b7a8029efd07186a4d6804b86c2206b29031da7fdf'
          AND pg_catalog.encode(
                pg_catalog.sha256(
                  pg_catalog.convert_to(
                    pg_catalog.pg_get_functiondef(routine.oid),
                    'UTF8'
                  )
                ),
                'hex'
              ) =
                'b3ba15cae78eaf8e3535b28c0764e9715683e15ab85b0814089e3e54715f4676'
          AND (
            SELECT pg_catalog.array_agg(
                     (
                       CASE WHEN acl.grantee = 0
                         THEN 'PUBLIC'
                         ELSE pg_catalog.pg_get_userbyid(acl.grantee)
                       END
                     ) || '|' || acl.privilege_type || '|' ||
                     acl.is_grantable::text
                     ORDER BY acl.grantee, acl.privilege_type,
                              acl.is_grantable
                   )
              FROM pg_catalog.aclexplode(
                     coalesce(
                       routine.proacl,
                       pg_catalog.acldefault('f', routine.proowner)
                     )
                   ) acl
          ) IS NOT DISTINCT FROM
                ARRAY['learncoding_owner|EXECUTE|false']::text[]
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger trigger
        WHERE trigger.tgrelid =
                'public.email_outbox'::pg_catalog.regclass
          AND trigger.tgname =
                'email_outbox_dispatch_binding_guard'
          AND NOT trigger.tgisinternal
          AND trigger.tgfoid = pg_catalog.to_regprocedure(
                'public.enforce_email_outbox_dispatch_binding()'
              )
          AND trigger.tgenabled = 'O'
          AND trigger.tgtype = 23
          AND trigger.tgqual IS NULL
          AND trigger.tgnargs = 0
          AND pg_catalog.octet_length(trigger.tgargs) = 0
          AND trigger.tgattr = ''::pg_catalog.int2vector
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_constraint constraint_record
        WHERE constraint_record.conrelid =
                'public.email_outbox'::pg_catalog.regclass
          AND constraint_record.conname =
                'email_outbox_dispatch_binding_valid'
          AND constraint_record.contype = 'c'
          AND constraint_record.convalidated
          AND NOT constraint_record.connoinherit
          AND pg_catalog.regexp_replace(
                pg_catalog.regexp_replace(
                  pg_catalog.pg_get_expr(
                    constraint_record.conbin,
                    constraint_record.conrelid,
                    true
                  ),
                  '"?email_outbox"?[.]',
                  '',
                  'g'
                ),
                '[[:space:]"]',
                '',
                'g'
              ) =
                'provider_call_startedISNULLANDadapterISNULLANDprovider_message_idISNULLANDdispatch_binding_versionISNULLANDdispatch_binding_sha256ISNULLORprovider_call_startedISNOTNULLAND(status=ANY(ARRAY[''sending''::notification_status,''sent''::notification_status,''failed''::notification_status,''quarantined''::notification_status]))AND(adapter=''gmail''::textAND(dispatch_binding_versionISNULLANDdispatch_binding_sha256ISNULLORdispatch_binding_version=''gmail-raw-v1''::textANDdispatch_binding_sha256~''^[0-9a-f]{64}$''::text)ORadapter=''console''::textAND(dispatch_binding_versionISNULLANDdispatch_binding_sha256ISNULLORdispatch_binding_version=''console-json-v1''::textANDdispatch_binding_sha256~''^[0-9a-f]{64}$''::text))'
          AND (
            SELECT pg_catalog.array_agg(
                     attribute.attname::text ORDER BY attribute.attname
                   )
              FROM pg_catalog.unnest(constraint_record.conkey)
                   constrained(attnum)
              JOIN pg_catalog.pg_attribute attribute
                ON attribute.attrelid = constraint_record.conrelid
               AND attribute.attnum = constrained.attnum
          ) IS NOT DISTINCT FROM ARRAY[
                'adapter',
                'dispatch_binding_sha256',
                'dispatch_binding_version',
                'provider_call_started',
                'provider_message_id',
                'status'
              ]::text[]
     )
     OR (
       SELECT pg_catalog.count(*) <> 2
              OR NOT pg_catalog.bool_and(
                attribute.atttypid =
                  'pg_catalog.text'::pg_catalog.regtype
                AND attribute.atttypmod = -1
                AND NOT attribute.attnotnull
                AND NOT attribute.atthasdef
                AND attribute.attgenerated = ''
                AND attribute.attidentity = ''
                AND NOT attribute.attisdropped
                AND (
                  SELECT pg_catalog.array_agg(
                           (
                             CASE WHEN acl.grantee = 0
                               THEN 'PUBLIC'
                               ELSE pg_catalog.pg_get_userbyid(acl.grantee)
                             END
                           ) || '|' || acl.privilege_type || '|' ||
                           acl.is_grantable::text
                           ORDER BY acl.grantee, acl.privilege_type,
                                    acl.is_grantable
                         )
                    FROM pg_catalog.aclexplode(attribute.attacl) acl
                ) IS NOT DISTINCT FROM
                      ARRAY['learncoding_worker|UPDATE|false']::text[]
              )
         FROM pg_catalog.pg_attribute attribute
        WHERE attribute.attrelid =
                'public.email_outbox'::pg_catalog.regclass
          AND attribute.attname IN (
                'dispatch_binding_version',
                'dispatch_binding_sha256'
              )
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_class relation
        WHERE relation.oid = 'public.email_outbox'::pg_catalog.regclass
          AND relation.relkind IN ('r', 'p')
          AND pg_catalog.pg_get_userbyid(relation.relowner) =
                'learncoding_owner'
     )
     OR pg_catalog.to_regprocedure(
       'public.enforce_email_outbox_dispatch_binding()'
     ) IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_constraint constraint_record
         JOIN pg_catalog.pg_class relation
           ON relation.oid = constraint_record.conrelid
         JOIN pg_catalog.pg_namespace namespace_record
           ON namespace_record.oid = relation.relnamespace
        WHERE namespace_record.nspname = 'public'
          AND relation.relname = 'email_outbox'
          AND constraint_record.conname =
                'email_outbox_dispatch_binding_valid'
          AND constraint_record.contype = 'c'
          AND constraint_record.convalidated
     )
     OR EXISTS (
       SELECT 1
         FROM public.email_outbox
        WHERE (
          provider_call_started IS NULL
          AND (
            adapter IS NOT NULL
            OR provider_message_id IS NOT NULL
            OR dispatch_binding_version IS NOT NULL
            OR dispatch_binding_sha256 IS NOT NULL
          )
        )
        OR (
          provider_call_started IS NOT NULL
          AND (
            adapter IS NULL
            OR adapter NOT IN ('gmail', 'console')
            OR status NOT IN ('sending', 'sent', 'failed', 'quarantined')
          )
        )
        OR (
          last_error_code = 'LEGACY_SENDING_AMBIGUOUS'
          AND NOT (
            status = 'quarantined'
            AND provider_call_started IS NULL
            AND adapter IS NULL
            AND provider_message_id IS NULL
            AND claim_version = 0
            AND dispatch_binding_version IS NULL
            AND dispatch_binding_sha256 IS NULL
            AND claim_token IS NULL
            AND claim_owner IS NULL
            AND lease_expires_at IS NULL
            AND sent_at IS NULL
            AND quarantined_at IS NOT NULL
          )
        )
     )
  THEN
    RAISE EXCEPTION
      'email outbox provider correlation predecessor state is invalid'
      USING ERRCODE = '23514';
  END IF;
END
$preflight$;--> statement-breakpoint
ALTER TABLE public.email_outbox
  ADD COLUMN "provider_correlation_version" text,
  ADD COLUMN "provider_evidence_version" text,
  ADD COLUMN "provider_evidence_sha256" text;--> statement-breakpoint
UPDATE public.email_outbox
   SET provider_correlation_version = 'legacy-raw-v0'
 WHERE provider_call_started IS NOT NULL
    OR (
      status = 'quarantined'
      AND provider_call_started IS NULL
      AND adapter IS NULL
      AND provider_message_id IS NULL
      AND claim_version = 0
      AND dispatch_binding_version IS NULL
      AND dispatch_binding_sha256 IS NULL
      AND claim_token IS NULL
      AND claim_owner IS NULL
      AND lease_expires_at IS NULL
      AND sent_at IS NULL
      AND quarantined_at IS NOT NULL
      AND last_error_code = 'LEGACY_SENDING_AMBIGUOUS'
    );--> statement-breakpoint
ALTER TABLE public.email_outbox
  ADD CONSTRAINT "email_outbox_provider_correlation_evidence_valid"
  CHECK ((
    (
      provider_call_started IS NULL
      AND adapter IS NULL
      AND provider_message_id IS NULL
      AND last_error_code IS DISTINCT FROM
            'LEGACY_SENDING_AMBIGUOUS'
      AND dispatch_binding_version IS NULL
      AND dispatch_binding_sha256 IS NULL
      AND provider_correlation_version IS NULL
      AND provider_evidence_version IS NULL
      AND provider_evidence_sha256 IS NULL
    )
    OR (
      status = 'quarantined'
      AND provider_call_started IS NULL
      AND adapter IS NULL
      AND provider_message_id IS NULL
      AND claim_version = 0
      AND dispatch_binding_version IS NULL
      AND dispatch_binding_sha256 IS NULL
      AND claim_token IS NULL
      AND claim_owner IS NULL
      AND lease_expires_at IS NULL
      AND sent_at IS NULL
      AND quarantined_at IS NOT NULL
      AND last_error_code = 'LEGACY_SENDING_AMBIGUOUS'
      AND provider_correlation_version = 'legacy-raw-v0'
      AND provider_evidence_version IS NULL
      AND provider_evidence_sha256 IS NULL
    )
    OR (
      provider_call_started IS NOT NULL
      AND adapter IN ('gmail', 'console')
      AND status IN ('sending', 'sent', 'failed', 'quarantined')
      AND (
        (
          provider_correlation_version = 'legacy-raw-v0'
          AND provider_evidence_version IS NULL
          AND provider_evidence_sha256 IS NULL
        )
        OR (
          provider_correlation_version = 'opaque-sha256-v1'
          AND (
            (
              adapter = 'gmail'
              AND dispatch_binding_version = 'gmail-raw-v1'
              AND dispatch_binding_sha256 ~ '^[0-9a-f]{64}$'
              AND provider_evidence_version =
                    'gmail-header-evidence-v1'
              AND provider_evidence_sha256 ~ '^[0-9a-f]{64}$'
            )
            OR (
              adapter = 'console'
              AND dispatch_binding_version = 'console-json-v1'
              AND dispatch_binding_sha256 ~ '^[0-9a-f]{64}$'
              AND provider_evidence_version IS NULL
              AND provider_evidence_sha256 IS NULL
            )
          )
        )
      )
    )
  ) IS TRUE) NOT VALID;--> statement-breakpoint
ALTER TABLE public.email_outbox
  VALIDATE CONSTRAINT
    email_outbox_provider_correlation_evidence_valid;--> statement-breakpoint
CREATE FUNCTION
  "public"."enforce_email_outbox_provider_correlation_evidence"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
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

  IF current_user <> 'learncoding_worker'
     OR session_user <> 'learncoding_worker' THEN
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
$function$;--> statement-breakpoint
ALTER FUNCTION
  "public"."enforce_email_outbox_provider_correlation_evidence"()
  OWNER TO learncoding_owner;--> statement-breakpoint
DO $seal_function_acl$
DECLARE
  candidate_grantee oid;
  candidate_name name;
BEGIN
  FOR candidate_grantee IN
    SELECT DISTINCT expanded.grantee
      FROM pg_catalog.pg_proc AS routine
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          routine.proacl,
          pg_catalog.acldefault('f', routine.proowner)
        )
      ) AS expanded
     WHERE routine.oid = pg_catalog.to_regprocedure(
       'public.enforce_email_outbox_provider_correlation_evidence()'
     )
  LOOP
    IF candidate_grantee = 0 THEN
      EXECUTE
        'REVOKE ALL ON FUNCTION ' ||
        'public.enforce_email_outbox_provider_correlation_evidence() ' ||
        'FROM PUBLIC CASCADE';
    ELSE
      candidate_name := pg_catalog.pg_get_userbyid(candidate_grantee);
      IF candidate_name IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL ON FUNCTION ' ||
          'public.enforce_email_outbox_provider_correlation_evidence() ' ||
          'FROM %I CASCADE',
          candidate_name
        );
      END IF;
    END IF;
  END LOOP;
END
$seal_function_acl$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  "public"."enforce_email_outbox_provider_correlation_evidence"()
  TO learncoding_owner;--> statement-breakpoint
CREATE TRIGGER "email_outbox_provider_correlation_evidence_guard"
BEFORE INSERT OR UPDATE ON public.email_outbox
FOR EACH ROW
EXECUTE FUNCTION
  "public"."enforce_email_outbox_provider_correlation_evidence"();--> statement-breakpoint
DO $seal_column_acl$
DECLARE
  candidate_grantee oid;
  candidate_name name;
BEGIN
  FOR candidate_grantee IN
    SELECT DISTINCT expanded.grantee
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        attribute.attacl
      ) AS expanded
     WHERE attribute.attrelid = 'public.email_outbox'::pg_catalog.regclass
       AND attribute.attname = ANY (ARRAY[
         'provider_correlation_version',
         'provider_evidence_version',
         'provider_evidence_sha256'
       ]::pg_catalog.name[])
       AND NOT attribute.attisdropped
  LOOP
    IF candidate_grantee = 0 THEN
      EXECUTE
        'REVOKE ALL (' ||
        'provider_correlation_version, provider_evidence_version, ' ||
        'provider_evidence_sha256' ||
        ') ON TABLE public.email_outbox FROM PUBLIC CASCADE';
    ELSE
      candidate_name := pg_catalog.pg_get_userbyid(candidate_grantee);
      IF candidate_name IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL (' ||
          'provider_correlation_version, provider_evidence_version, ' ||
          'provider_evidence_sha256' ||
          ') ON TABLE public.email_outbox FROM %I CASCADE',
          candidate_name
        );
      END IF;
    END IF;
  END LOOP;
END
$seal_column_acl$;--> statement-breakpoint
GRANT UPDATE (
  provider_correlation_version,
  provider_evidence_version,
  provider_evidence_sha256
) ON TABLE public.email_outbox TO learncoding_worker;
--> statement-breakpoint
DO $verify_provider_authority_acl$
DECLARE
  function_acl_exact boolean;
  column_acl_exact boolean;
BEGIN
  WITH target AS (
    SELECT routine.oid, routine.proowner
      FROM pg_catalog.pg_proc AS routine
     WHERE routine.oid = pg_catalog.to_regprocedure(
       'public.enforce_email_outbox_provider_correlation_evidence()'
     )
  ),
  observed(grantor, grantee, privilege_type, is_grantable) AS (
    SELECT expanded.grantor,
           expanded.grantee,
           expanded.privilege_type,
           expanded.is_grantable
      FROM target
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          (
            SELECT routine.proacl
              FROM pg_catalog.pg_proc AS routine
             WHERE routine.oid = target.oid
          ),
          pg_catalog.acldefault('f', target.proowner)
        )
      ) AS expanded
  ),
  expected(grantor, grantee, privilege_type, is_grantable) AS (
    SELECT owner_role.oid,
           owner_role.oid,
           'EXECUTE'::text,
           false
      FROM pg_catalog.pg_roles AS owner_role
     WHERE owner_role.rolname = 'learncoding_owner'
  )
  SELECT NOT EXISTS (
    (SELECT * FROM observed EXCEPT ALL SELECT * FROM expected)
    UNION ALL
    (SELECT * FROM expected EXCEPT ALL SELECT * FROM observed)
  )
    INTO function_acl_exact;

  WITH observed(
    column_name, grantor, grantee, privilege_type, is_grantable
  ) AS (
    SELECT attribute.attname::text,
           expanded.grantor,
           expanded.grantee,
           expanded.privilege_type,
           expanded.is_grantable
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS expanded
     WHERE attribute.attrelid = 'public.email_outbox'::pg_catalog.regclass
       AND attribute.attname = ANY (ARRAY[
         'provider_correlation_version',
         'provider_evidence_version',
         'provider_evidence_sha256'
       ]::pg_catalog.name[])
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
  ),
  expected(
    column_name, grantor, grantee, privilege_type, is_grantable
  ) AS (
    SELECT column_name,
           owner_role.oid,
           worker_role.oid,
           'UPDATE'::text,
           false
      FROM pg_catalog.unnest(ARRAY[
        'provider_correlation_version',
        'provider_evidence_version',
        'provider_evidence_sha256'
      ]::text[]) AS reviewed(column_name)
      CROSS JOIN pg_catalog.pg_roles AS owner_role
      CROSS JOIN pg_catalog.pg_roles AS worker_role
     WHERE owner_role.rolname = 'learncoding_owner'
       AND worker_role.rolname = 'learncoding_worker'
  )
  SELECT NOT EXISTS (
    (SELECT * FROM observed EXCEPT ALL SELECT * FROM expected)
    UNION ALL
    (SELECT * FROM expected EXCEPT ALL SELECT * FROM observed)
  )
    INTO column_acl_exact;

  IF function_acl_exact IS DISTINCT FROM true
     OR column_acl_exact IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'email outbox provider authority ACL contract is invalid'
      USING ERRCODE = '42501';
  END IF;
END
$verify_provider_authority_acl$;
