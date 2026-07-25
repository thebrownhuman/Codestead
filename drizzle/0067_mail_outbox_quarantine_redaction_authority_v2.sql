-- Forward-only SQL component. Journal/snapshot/ledger metadata is added only
-- after the exact reviewed 0065/0066 predecessor chain is frozen.
LOCK TABLE ONLY public.email_outbox IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
DO $preflight$
BEGIN
  IF NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_proc AS routine
         JOIN pg_catalog.pg_language AS language
           ON language.oid = routine.prolang
        WHERE routine.oid = pg_catalog.to_regprocedure(
                'public.enforce_email_outbox_provider_correlation_evidence()'
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
          AND routine.proargnames IS NULL
          AND routine.proargmodes IS NULL
          AND routine.proallargtypes IS NULL
          AND routine.proargtypes = ''::pg_catalog.oidvector
          AND routine.prorettype =
                'pg_catalog.trigger'::pg_catalog.regtype
          AND NOT routine.proretset
          AND routine.provariadic = 0
          AND pg_catalog.current_setting(
                'server_version_num'
              )::integer >= 170000
          AND pg_catalog.current_setting(
                'server_version_num'
              )::integer < 190000
          AND pg_catalog.encode(
                pg_catalog.sha256(
                  pg_catalog.convert_to(routine.prosrc, 'UTF8')
                ),
                'hex'
              ) =
                '62ff4885055979fb7eaf0fda3ae8170a14a430cb69d8f310e6aba742cf700e1a'
          AND pg_catalog.encode(
                pg_catalog.sha256(
                  pg_catalog.convert_to(
                    pg_catalog.pg_get_functiondef(routine.oid),
                    'UTF8'
                  )
                ),
                'hex'
              ) =
                'afaab6796f97aa0294ff5a761679895f9ccfb78fea21e0be362979c5c4e5ab11'
          AND (
            SELECT pg_catalog.array_agg(
                     pg_catalog.pg_get_userbyid(acl.grantor) || '|' ||
                     (
                       CASE WHEN acl.grantee = 0
                         THEN 'PUBLIC'
                         ELSE pg_catalog.pg_get_userbyid(acl.grantee)
                       END
                     ) || '|' || acl.privilege_type || '|' ||
                     acl.is_grantable::text
                     ORDER BY
                       pg_catalog.pg_get_userbyid(acl.grantor),
                       CASE WHEN acl.grantee = 0
                         THEN 'PUBLIC'
                         ELSE pg_catalog.pg_get_userbyid(acl.grantee)
                       END,
                       acl.privilege_type,
                       acl.is_grantable
                   )
              FROM pg_catalog.aclexplode(
                COALESCE(
                  routine.proacl,
                  pg_catalog.acldefault('f', routine.proowner)
                )
              ) AS acl
          ) IS NOT DISTINCT FROM ARRAY[
                'learncoding_owner|learncoding_owner|EXECUTE|false'
              ]::text[]
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger AS trigger_record
        WHERE trigger_record.tgrelid =
                'public.email_outbox'::pg_catalog.regclass
          AND trigger_record.tgname =
                'email_outbox_provider_correlation_evidence_guard'
          AND NOT trigger_record.tgisinternal
          AND trigger_record.tgfoid = pg_catalog.to_regprocedure(
                'public.enforce_email_outbox_provider_correlation_evidence()'
              )
          AND trigger_record.tgenabled = 'O'
          AND trigger_record.tgtype = 23
          AND trigger_record.tgqual IS NULL
          AND trigger_record.tgnargs = 0
          AND pg_catalog.octet_length(trigger_record.tgargs) = 0
          AND trigger_record.tgattr = ''::pg_catalog.int2vector
          AND trigger_record.tgparentid = 0
          AND trigger_record.tgconstraint = 0
          AND trigger_record.tgconstrrelid = 0
          AND trigger_record.tgconstrindid = 0
          AND NOT trigger_record.tgdeferrable
          AND NOT trigger_record.tginitdeferred
          AND trigger_record.tgoldtable IS NULL
          AND trigger_record.tgnewtable IS NULL
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_constraint AS constraint_record
        WHERE constraint_record.conrelid =
                'public.email_outbox'::pg_catalog.regclass
          AND constraint_record.conname =
                'email_outbox_provider_correlation_evidence_valid'
          AND constraint_record.contype = 'c'
          AND constraint_record.convalidated
          AND COALESCE(
                (
                  pg_catalog.to_jsonb(constraint_record)
                  ->> 'conenforced'
                )::boolean,
                true
              )
          AND NOT constraint_record.connoinherit
          AND NOT constraint_record.condeferrable
          AND NOT constraint_record.condeferred
          AND pg_catalog.encode(
                pg_catalog.sha256(
                  pg_catalog.convert_to(
                    pg_catalog.pg_get_expr(
                      constraint_record.conbin,
                      constraint_record.conrelid,
                      false
                    ),
                    'UTF8'
                  )
                ),
                'hex'
              ) =
                CASE
                  WHEN pg_catalog.current_setting(
                         'server_version_num'
                       )::integer >= 170000
                   AND pg_catalog.current_setting(
                         'server_version_num'
                       )::integer < 190000
                    THEN
                      'cc196df96da9024d65c85ef3451eae1f1dd059672226ba8c37c2e7d2af374bd9'
                  ELSE NULL
                END
          AND pg_catalog.encode(
                pg_catalog.sha256(
                  pg_catalog.convert_to(
                    pg_catalog.pg_get_constraintdef(
                      constraint_record.oid,
                      false
                    ),
                    'UTF8'
                  )
                ),
                'hex'
              ) =
                CASE
                  WHEN pg_catalog.current_setting(
                         'server_version_num'
                       )::integer >= 170000
                   AND pg_catalog.current_setting(
                         'server_version_num'
                       )::integer < 190000
                    THEN
                      'fa3258f9172adbefc2cbb58a57d63533f8933811c77d0d3eb1b285f6bd2dd4da'
                  ELSE NULL
                END
          AND (
            SELECT pg_catalog.array_agg(
                     attribute.attname::text ORDER BY constrained.position
                   )
              FROM pg_catalog.unnest(constraint_record.conkey)
                   WITH ORDINALITY AS constrained(attnum, position)
              JOIN pg_catalog.pg_attribute AS attribute
                ON attribute.attrelid = constraint_record.conrelid
               AND attribute.attnum = constrained.attnum
          ) IS NOT DISTINCT FROM ARRAY[
                'provider_call_started',
                'adapter',
                'provider_message_id',
                'last_error_code',
                'dispatch_binding_version',
                'dispatch_binding_sha256',
                'provider_correlation_version',
                'provider_evidence_version',
                'provider_evidence_sha256',
                'status',
                'claim_version',
                'claim_token',
                'claim_owner',
                'lease_expires_at',
                'sent_at',
                'quarantined_at'
              ]::text[]
     )
     OR (
       SELECT pg_catalog.count(*) <> 3
              OR NOT pg_catalog.bool_and(
                attribute.atttypid =
                  'pg_catalog.text'::pg_catalog.regtype
                AND attribute.atttypmod = -1
                AND attribute.attcollation =
                      pg_catalog.to_regcollation('pg_catalog."default"')
                AND NOT attribute.attnotnull
                AND NOT attribute.atthasdef
                AND attribute.attidentity = ''
                AND attribute.attgenerated = ''
                AND NOT attribute.attisdropped
                AND attribute.attislocal
                AND attribute.attinhcount = 0
                AND (
                  SELECT pg_catalog.array_agg(
                           pg_catalog.pg_get_userbyid(acl.grantor) || '|' ||
                           (
                             CASE WHEN acl.grantee = 0
                               THEN 'PUBLIC'
                               ELSE pg_catalog.pg_get_userbyid(acl.grantee)
                             END
                           ) || '|' || acl.privilege_type || '|' ||
                           acl.is_grantable::text
                           ORDER BY
                             pg_catalog.pg_get_userbyid(acl.grantor),
                             CASE WHEN acl.grantee = 0
                               THEN 'PUBLIC'
                               ELSE pg_catalog.pg_get_userbyid(acl.grantee)
                             END,
                             acl.privilege_type,
                             acl.is_grantable
                         )
                    FROM pg_catalog.aclexplode(attribute.attacl) AS acl
                ) IS NOT DISTINCT FROM ARRAY[
                      'learncoding_owner|learncoding_worker|UPDATE|false'
                    ]::text[]
              )
         FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid =
                'public.email_outbox'::pg_catalog.regclass
          AND attribute.attname = ANY (ARRAY[
                'provider_correlation_version',
                'provider_evidence_version',
                'provider_evidence_sha256'
              ]::pg_catalog.name[])
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_class AS relation
        WHERE relation.oid =
                'public.email_outbox'::pg_catalog.regclass
          AND relation.relkind = 'r'
          AND relation.relpersistence = 'p'
          AND pg_catalog.pg_get_userbyid(relation.relowner) =
                'learncoding_owner'
          AND NOT relation.relrowsecurity
          AND NOT relation.relforcerowsecurity
          AND NOT relation.relispartition
          AND relation.relpartbound IS NULL
          AND relation.reloftype = 0
          AND NOT relation.relhassubclass
          AND NOT relation.relhasrules
          AND NOT EXISTS (
                SELECT 1
                  FROM pg_catalog.pg_inherits AS inheritance
                 WHERE inheritance.inhrelid = relation.oid
                    OR inheritance.inhparent = relation.oid
              )
          AND NOT EXISTS (
                SELECT 1
                  FROM pg_catalog.pg_rewrite AS rewrite_rule
                 WHERE rewrite_rule.ev_class = relation.oid
              )
          AND pg_catalog.has_table_privilege(
                'learncoding_worker',
                relation.oid,
                'SELECT'
              )
          AND NOT pg_catalog.has_table_privilege(
                'learncoding_worker',
                relation.oid,
                'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
              )
     )
  THEN
    RAISE EXCEPTION
      'email outbox quarantine redaction predecessor is invalid'
      USING ERRCODE = '23514';
  END IF;
END
$preflight$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION
  "public"."classify_email_outbox_quarantine_redaction_v2"(
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
  age_anchor timestamp with time zone;
  expected_email text;
  expected_variables jsonb;
  raw_disposition text;
  claim_authority_parts integer;
BEGIN
  IF candidate.id IS NULL
     OR cutoff_at IS NULL
     OR candidate.status IS DISTINCT FROM
          'quarantined'::public.notification_status THEN
    RETURN NULL;
  END IF;

  age_anchor := COALESCE(
    candidate.quarantined_at,
    candidate.updated_at,
    candidate.created_at
  );
  IF age_anchor IS NULL OR age_anchor >= cutoff_at THEN
    RETURN NULL;
  END IF;

  expected_email :=
    'redacted+' || candidate.id::text || '@invalid.local';
  IF candidate.user_id IS NOT NULL
     AND candidate.delivery_scope_key IS NOT DISTINCT FROM
           'a:' || candidate.user_id THEN
    raw_disposition := 'eligible_account';
    expected_variables := '{}'::jsonb;
  ELSIF candidate.user_id IS NULL
        AND candidate.delivery_scope_key IS NOT DISTINCT FROM
              's:' || candidate.operation_id::text
        AND candidate.template_version IS NOT DISTINCT FROM '1'
        AND candidate.variables ->> '_mailOperationId'
              IS NOT DISTINCT FROM candidate.operation_id::text
        AND candidate.variables ->> '_mailRecipient'
              IS NOT DISTINCT FROM candidate.to_email
        AND COALESCE(
              candidate.variables ->> '_mailSourceId'
                ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
              false
            )
        AND (
          (
            candidate.template = 'access-request-admin'
            AND candidate.variables ->> '_mailProducer'
                  IS NOT DISTINCT FROM 'access-request-admin'
          )
          OR (
            candidate.template = 'invitation'
            AND candidate.variables ->> '_mailProducer'
                  IS NOT DISTINCT FROM 'access-request-approved'
          )
          OR (
            candidate.template = 'access-rejected'
            AND candidate.variables ->> '_mailProducer'
                  IS NOT DISTINCT FROM 'access-request-rejected'
          )
        ) THEN
    raw_disposition := 'eligible_system';
    expected_variables := pg_catalog.jsonb_build_object(
      '_mailOperationId', candidate.operation_id::text,
      '_mailRecipient', expected_email,
      '_mailProducer', candidate.variables ->> '_mailProducer',
      '_mailSourceId', candidate.variables ->> '_mailSourceId'
    );
  ELSIF candidate.user_id IS NULL
        AND candidate.delivery_scope_key IS NOT DISTINCT FROM
              'o:' || candidate.operation_id::text THEN
    raw_disposition := 'eligible_operation';
    expected_variables := '{}'::jsonb;
  ELSE
    -- A validated delivery-scope constraint prevents this shape in a healthy
    -- catalog. If an inherited or manually damaged row exists, payload
    -- minimization remains safe and the non-PII malformed scope is retained.
    raw_disposition := 'eligible_malformed';
    expected_variables := '{}'::jsonb;
  END IF;

  IF candidate.to_email IS NOT DISTINCT FROM expected_email
     AND candidate.variables IS NOT DISTINCT FROM expected_variables THEN
    RETURN NULL;
  END IF;

  claim_authority_parts := pg_catalog.num_nonnulls(
    candidate.claim_token,
    candidate.claim_owner,
    candidate.lease_expires_at
  );
  IF claim_authority_parts = 0 THEN
    RETURN raw_disposition;
  END IF;
  IF claim_authority_parts BETWEEN 1 AND 2 THEN
    -- Partial tuples cannot become a valid resend claim. Redact the payload
    -- while preserving the malformed non-PII authority for operator repair.
    RETURN raw_disposition;
  END IF;
  IF claim_authority_parts = 3
     AND candidate.lease_expires_at >
           pg_catalog.statement_timestamp() THEN
    RETURN 'blocked';
  END IF;

  -- A complete but expired claim no longer carries live send authority.
  RETURN raw_disposition;
END
$function$;--> statement-breakpoint
ALTER FUNCTION
  "public"."classify_email_outbox_quarantine_redaction_v2"(
    "public"."email_outbox",
    timestamp with time zone
  ) OWNER TO learncoding_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION
  "public"."classify_email_outbox_quarantine_redaction_v2"(
    "public"."email_outbox",
    timestamp with time zone
  ) FROM learncoding_owner CASCADE;--> statement-breakpoint
REVOKE ALL ON FUNCTION
  "public"."classify_email_outbox_quarantine_redaction_v2"(
    "public"."email_outbox",
    timestamp with time zone
  ) FROM PUBLIC, learncoding_app, learncoding_worker,
         learncoding_migrator, learncoding_ops CASCADE;--> statement-breakpoint
DO $seal_classifier_acl$
DECLARE
  candidate_grantee oid;
  candidate_name name;
BEGIN
  FOR candidate_grantee IN
    SELECT DISTINCT expanded.grantee
      FROM pg_catalog.pg_proc AS routine
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        CASE
          WHEN routine.proacl IS NULL
            OR pg_catalog.cardinality(routine.proacl) = 0
            THEN pg_catalog.acldefault('f', routine.proowner)
          ELSE routine.proacl
        END
      ) AS expanded
     WHERE routine.oid = pg_catalog.to_regprocedure(
       'public.classify_email_outbox_quarantine_redaction_v2(public.email_outbox,timestamp with time zone)'
     )

  LOOP
    IF candidate_grantee = 0 THEN
      EXECUTE
        'REVOKE ALL ON FUNCTION ' ||
        'public.classify_email_outbox_quarantine_redaction_v2(' ||
        'public.email_outbox, timestamp with time zone) FROM PUBLIC CASCADE';
    ELSE
      candidate_name := pg_catalog.pg_get_userbyid(candidate_grantee);
      IF candidate_name IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL ON FUNCTION ' ||
          'public.classify_email_outbox_quarantine_redaction_v2(' ||
          'public.email_outbox, timestamp with time zone) FROM %I CASCADE',
          candidate_name
        );
      END IF;
    END IF;
  END LOOP;
END
$seal_classifier_acl$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  "public"."classify_email_outbox_quarantine_redaction_v2"(
    "public"."email_outbox",
    timestamp with time zone
  ) TO learncoding_owner;--> statement-breakpoint
CREATE OR REPLACE FUNCTION
  "public"."enforce_email_outbox_payload_immutable"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  redaction_disposition text;
  expected_email text;
  expected_variables jsonb;
BEGIN
  IF current_user = 'learncoding_owner'
     AND session_user = 'learncoding_ops' THEN
    redaction_disposition :=
      "public"."classify_email_outbox_quarantine_redaction_v2"(
        OLD,
        pg_catalog.statement_timestamp() - interval '30 days'
      );
    expected_email := 'redacted+' || OLD.id::text || '@invalid.local';
    expected_variables :=
      CASE WHEN redaction_disposition = 'eligible_system'
        THEN pg_catalog.jsonb_build_object(
          '_mailOperationId', OLD.operation_id::text,
          '_mailRecipient', expected_email,
          '_mailProducer', OLD.variables ->> '_mailProducer',
          '_mailSourceId', OLD.variables ->> '_mailSourceId'
        )
        ELSE '{}'::jsonb
      END;

    IF redaction_disposition IN (
         'eligible_account',
         'eligible_system',
         'eligible_operation',
         'eligible_malformed'
       )
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
       AND OLD.provider_call_started
             IS NOT DISTINCT FROM NEW.provider_call_started
       AND OLD.adapter IS NOT DISTINCT FROM NEW.adapter
       AND OLD.dispatch_binding_version
             IS NOT DISTINCT FROM NEW.dispatch_binding_version
       AND OLD.dispatch_binding_sha256
             IS NOT DISTINCT FROM NEW.dispatch_binding_sha256
       AND OLD.provider_message_id
             IS NOT DISTINCT FROM NEW.provider_message_id
       AND OLD.provider_correlation_version
             IS NOT DISTINCT FROM NEW.provider_correlation_version
       AND OLD.provider_evidence_version
             IS NOT DISTINCT FROM NEW.provider_evidence_version
       AND OLD.provider_evidence_sha256
             IS NOT DISTINCT FROM NEW.provider_evidence_sha256
       AND OLD.next_attempt_at IS NOT DISTINCT FROM NEW.next_attempt_at
       AND OLD.sent_at IS NOT DISTINCT FROM NEW.sent_at
       AND OLD.quarantined_at IS NOT DISTINCT FROM NEW.quarantined_at
       AND OLD.last_error_code IS NOT DISTINCT FROM NEW.last_error_code
       AND OLD.created_at IS NOT DISTINCT FROM NEW.created_at THEN
      RETURN NEW;
    END IF;
  END IF;

  IF OLD.user_id IS DISTINCT FROM NEW.user_id THEN
    RAISE EXCEPTION 'email_outbox.user_id is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.to_email IS DISTINCT FROM NEW.to_email THEN
    RAISE EXCEPTION 'email_outbox.to_email is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.template IS DISTINCT FROM NEW.template THEN
    RAISE EXCEPTION 'email_outbox.template is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.template_version IS DISTINCT FROM NEW.template_version THEN
    RAISE EXCEPTION 'email_outbox.template_version is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.variables IS DISTINCT FROM NEW.variables THEN
    RAISE EXCEPTION 'email_outbox.variables is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key THEN
    RAISE EXCEPTION 'email_outbox.idempotency_key is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.operation_id IS DISTINCT FROM NEW.operation_id THEN
    RAISE EXCEPTION 'email_outbox.operation_id is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.delivery_scope_key IS DISTINCT FROM NEW.delivery_scope_key THEN
    RAISE EXCEPTION 'email_outbox.delivery_scope_key is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;--> statement-breakpoint
ALTER FUNCTION "public"."enforce_email_outbox_payload_immutable"()
  OWNER TO learncoding_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION
  "public"."enforce_email_outbox_payload_immutable"()
  FROM learncoding_owner CASCADE;--> statement-breakpoint
REVOKE ALL ON FUNCTION
  "public"."enforce_email_outbox_payload_immutable"()
  FROM PUBLIC, learncoding_app, learncoding_worker,
       learncoding_migrator, learncoding_ops CASCADE;--> statement-breakpoint
DO $seal_payload_trigger_acl$
DECLARE
  candidate_grantee oid;
  candidate_name name;
BEGIN
  FOR candidate_grantee IN
    SELECT DISTINCT expanded.grantee
      FROM pg_catalog.pg_proc AS routine
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        CASE
          WHEN routine.proacl IS NULL
            OR pg_catalog.cardinality(routine.proacl) = 0
            THEN pg_catalog.acldefault('f', routine.proowner)
          ELSE routine.proacl
        END
      ) AS expanded
     WHERE routine.oid = pg_catalog.to_regprocedure(
       'public.enforce_email_outbox_payload_immutable()'
     )

  LOOP
    IF candidate_grantee = 0 THEN
      EXECUTE
        'REVOKE ALL ON FUNCTION ' ||
        'public.enforce_email_outbox_payload_immutable() FROM PUBLIC CASCADE';
    ELSE
      candidate_name := pg_catalog.pg_get_userbyid(candidate_grantee);
      IF candidate_name IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL ON FUNCTION ' ||
          'public.enforce_email_outbox_payload_immutable() FROM %I CASCADE',
          candidate_name
        );
      END IF;
    END IF;
  END LOOP;
END
$seal_payload_trigger_acl$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  "public"."enforce_email_outbox_payload_immutable"()
  TO learncoding_owner;--> statement-breakpoint
DROP TRIGGER IF EXISTS "email_outbox_payload_immutable"
  ON public.email_outbox;--> statement-breakpoint
CREATE TRIGGER "email_outbox_payload_immutable"
BEFORE UPDATE OF
  "user_id",
  "to_email",
  "template",
  "template_version",
  "variables",
  "idempotency_key",
  "operation_id",
  "delivery_scope_key"
ON public.email_outbox
FOR EACH ROW
EXECUTE FUNCTION
  "public"."enforce_email_outbox_payload_immutable"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION
  "public"."redact_quarantined_email_outbox_authority_v2"(
    "cutoff_at" timestamp with time zone,
    "batch_limit" integer
  )
RETURNS TABLE(
  "disposition" text,
  "eligible" bigint,
  "transitioned" bigint
)
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
     OR cutoff_at >
          pg_catalog.statement_timestamp() - interval '30 days' THEN
    RAISE EXCEPTION
      'email outbox redaction cutoff violates retention policy'
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
             "public"."classify_email_outbox_quarantine_redaction_v2"(
               candidate,
               cutoff_at
             ) AS raw_disposition
        FROM public.email_outbox AS candidate
    ), summary AS (
      SELECT CASE
               WHEN classified.raw_disposition IN (
                 'eligible_account',
                 'eligible_system',
                 'eligible_operation'
               ) THEN 'eligible'
               WHEN classified.raw_disposition = 'eligible_malformed'
                 THEN 'malformed'
               ELSE classified.raw_disposition
             END AS disposition,
             pg_catalog.count(*)::bigint AS eligible
        FROM classified
       WHERE classified.raw_disposition IN (
         'eligible_account',
         'eligible_system',
         'eligible_operation',
         'eligible_malformed',
         'blocked'
       )
       GROUP BY CASE
         WHEN classified.raw_disposition IN (
           'eligible_account',
           'eligible_system',
           'eligible_operation'
         ) THEN 'eligible'
         WHEN classified.raw_disposition = 'eligible_malformed'
           THEN 'malformed'
         ELSE classified.raw_disposition
       END
    )
    SELECT dispositions.disposition,
           COALESCE(summary.eligible, 0)::bigint,
           0::bigint
      FROM (VALUES ('eligible'), ('blocked'), ('malformed'))
           AS dispositions(disposition)
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
           COALESCE(
             candidate.quarantined_at,
             candidate.updated_at,
             candidate.created_at
           ) AS age_anchor,
           "public"."classify_email_outbox_quarantine_redaction_v2"(
             candidate,
             cutoff_at
           ) AS raw_disposition
      FROM public.email_outbox AS candidate
  ), eligible_rows AS MATERIALIZED (
    SELECT candidate.id,
           classified.raw_disposition
      FROM public.email_outbox AS candidate
      JOIN classified ON classified.id = candidate.id
     WHERE classified.raw_disposition IN (
       'eligible_account',
       'eligible_system',
       'eligible_operation',
       'eligible_malformed'
     )
     ORDER BY classified.age_anchor, candidate.id
     LIMIT batch_limit
     FOR UPDATE OF candidate SKIP LOCKED
  ), redacted AS (
    UPDATE public.email_outbox AS outbox
       SET to_email =
             'redacted+' || outbox.id::text || '@invalid.local',
           variables = CASE
             WHEN eligible_rows.raw_disposition = 'eligible_system'
               THEN pg_catalog.jsonb_build_object(
                 '_mailOperationId', outbox.operation_id::text,
                 '_mailRecipient',
                   'redacted+' || outbox.id::text || '@invalid.local',
                 '_mailProducer', outbox.variables ->> '_mailProducer',
                 '_mailSourceId', outbox.variables ->> '_mailSourceId'
               )
             ELSE '{}'::jsonb
           END,
           updated_at = pg_catalog.statement_timestamp()
      FROM eligible_rows
     WHERE outbox.id = eligible_rows.id
       AND "public"."classify_email_outbox_quarantine_redaction_v2"(
             outbox,
             cutoff_at
           ) = eligible_rows.raw_disposition
    RETURNING outbox.id, eligible_rows.raw_disposition
  ), summary AS (
    SELECT CASE
             WHEN classified.raw_disposition IN (
               'eligible_account',
               'eligible_system',
               'eligible_operation'
             ) THEN 'eligible'
             WHEN classified.raw_disposition = 'eligible_malformed'
               THEN 'malformed'
             ELSE classified.raw_disposition
           END AS disposition,
           pg_catalog.count(*)::bigint AS eligible
      FROM classified
     WHERE classified.raw_disposition IN (
       'eligible_account',
       'eligible_system',
       'eligible_operation',
       'eligible_malformed',
       'blocked'
     )
     GROUP BY CASE
       WHEN classified.raw_disposition IN (
         'eligible_account',
         'eligible_system',
         'eligible_operation'
       ) THEN 'eligible'
       WHEN classified.raw_disposition = 'eligible_malformed'
         THEN 'malformed'
       ELSE classified.raw_disposition
     END
  ), redacted_summary AS (
    SELECT CASE
             WHEN redacted.raw_disposition IN (
               'eligible_account',
               'eligible_system',
               'eligible_operation'
             ) THEN 'eligible'
             ELSE 'malformed'
           END AS disposition,
           pg_catalog.count(*)::bigint AS transitioned
      FROM redacted
     GROUP BY CASE
       WHEN redacted.raw_disposition IN (
         'eligible_account',
         'eligible_system',
         'eligible_operation'
       ) THEN 'eligible'
       ELSE 'malformed'
     END
  )
  SELECT dispositions.disposition,
         COALESCE(summary.eligible, 0)::bigint,
         COALESCE(redacted_summary.transitioned, 0)::bigint
    FROM (VALUES ('eligible'), ('blocked'), ('malformed'))
         AS dispositions(disposition)
    LEFT JOIN summary ON summary.disposition = dispositions.disposition
    LEFT JOIN redacted_summary
      ON redacted_summary.disposition = dispositions.disposition
   ORDER BY CASE dispositions.disposition
     WHEN 'eligible' THEN 1
     WHEN 'blocked' THEN 2
     ELSE 3
   END;
END
$function$;--> statement-breakpoint
ALTER FUNCTION
  "public"."redact_quarantined_email_outbox_authority_v2"(
    timestamp with time zone,
    integer
  ) OWNER TO learncoding_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION
  "public"."redact_quarantined_email_outbox_authority_v2"(
    timestamp with time zone,
    integer
  ) FROM learncoding_owner CASCADE;--> statement-breakpoint
REVOKE ALL ON FUNCTION
  "public"."redact_quarantined_email_outbox_authority_v2"(
    timestamp with time zone,
    integer
  ) FROM PUBLIC, learncoding_app, learncoding_worker,
         learncoding_migrator, learncoding_ops CASCADE;--> statement-breakpoint
DO $seal_redactor_acl$
DECLARE
  candidate_grantee oid;
  candidate_name name;
BEGIN
  FOR candidate_grantee IN
    SELECT DISTINCT expanded.grantee
      FROM pg_catalog.pg_proc AS routine
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        CASE
          WHEN routine.proacl IS NULL
            OR pg_catalog.cardinality(routine.proacl) = 0
            THEN pg_catalog.acldefault('f', routine.proowner)
          ELSE routine.proacl
        END
      ) AS expanded
     WHERE routine.oid = pg_catalog.to_regprocedure(
       'public.redact_quarantined_email_outbox_authority_v2(timestamp with time zone,integer)'
     )

  LOOP
    IF candidate_grantee = 0 THEN
      EXECUTE
        'REVOKE ALL ON FUNCTION ' ||
        'public.redact_quarantined_email_outbox_authority_v2(' ||
        'timestamp with time zone, integer) FROM PUBLIC CASCADE';
    ELSE
      candidate_name := pg_catalog.pg_get_userbyid(candidate_grantee);
      IF candidate_name IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL ON FUNCTION ' ||
          'public.redact_quarantined_email_outbox_authority_v2(' ||
          'timestamp with time zone, integer) FROM %I CASCADE',
          candidate_name
        );
      END IF;
    END IF;
  END LOOP;
END
$seal_redactor_acl$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  "public"."redact_quarantined_email_outbox_authority_v2"(
    timestamp with time zone,
    integer
  ) TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  "public"."redact_quarantined_email_outbox_authority_v2"(
    timestamp with time zone,
    integer
  ) TO learncoding_ops;--> statement-breakpoint
DROP FUNCTION IF EXISTS
  "public"."redact_unresolved_email_outbox_authority"(
    timestamp with time zone,
    integer
  );--> statement-breakpoint
DROP FUNCTION IF EXISTS
  "public"."classify_email_outbox_retention_redaction"(
    "public"."email_outbox",
    timestamp with time zone
  );
