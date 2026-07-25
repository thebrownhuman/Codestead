-- Unnumbered component. Release composition must assign the contiguous ledger slot.
-- Writers must be drained before this ACCESS EXCLUSIVE cutover is applied.
LOCK TABLE public.email_outbox IN ACCESS EXCLUSIVE MODE;

CREATE FUNCTION public.email_outbox_original_payload_sha256(
  input_user_id text,
  input_to_email text,
  input_template text,
  input_template_version text,
  input_variables jsonb
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_array(
          pg_catalog.to_jsonb(input_user_id),
          pg_catalog.to_jsonb(pg_catalog.lower(pg_catalog.btrim(input_to_email) COLLATE "C")),
          pg_catalog.to_jsonb(input_template),
          pg_catalog.to_jsonb(input_template_version),
          input_variables - '_mailOperationId'
        )::text,
        'UTF8'
      )
    ),
    'hex'
  )
$function$;

ALTER FUNCTION public.email_outbox_original_payload_sha256(
  text, text, text, text, jsonb
) OWNER TO learncoding_owner;
REVOKE ALL ON FUNCTION public.email_outbox_original_payload_sha256(
  text, text, text, text, jsonb
) FROM PUBLIC, learncoding_app, learncoding_worker, learncoding_migrator,
       learncoding_ops CASCADE;

ALTER TABLE public.email_outbox
  ADD COLUMN idempotency_authority_version text,
  ADD COLUMN idempotency_authority_sha256 text,
  ADD COLUMN idempotency_original_payload_sha256 text;

CREATE TABLE public.email_outbox_idempotency_authority (
  idempotency_sha256 text PRIMARY KEY,
  original_payload_sha256 text NOT NULL,
  CONSTRAINT email_outbox_idempotency_authority_digest_valid
    CHECK (idempotency_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT email_outbox_idempotency_authority_payload_valid
    CHECK (original_payload_sha256 ~ '^[0-9a-f]{64}$')
);
ALTER TABLE public.email_outbox_idempotency_authority
  OWNER TO learncoding_owner;

UPDATE public.email_outbox
SET idempotency_authority_version = 'legacy-recipient-v1',
    idempotency_authority_sha256 = NULL,
    idempotency_original_payload_sha256 =
      public.email_outbox_original_payload_sha256(
        user_id,
        to_email,
        template,
        template_version,
        variables
      );

CREATE TEMP TABLE mail_outbox_proven_legacy_alias (
  outbox_id uuid PRIMARY KEY,
  idempotency_sha256 text NOT NULL,
  original_payload_sha256 text NOT NULL
);

WITH account_candidate AS (
  SELECT
    outbox.id,
    outbox.idempotency_key,
    outbox.user_id,
    outbox.to_email,
    outbox.template,
    outbox.template_version,
    outbox.variables,
    CASE
      WHEN outbox.template = 'reset-password'
        AND outbox.variables ->> 'resetVerificationId'
          ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN 'reset-password:' || (outbox.variables ->> 'resetVerificationId')
      WHEN outbox.template = 'lost-device-proof'
        AND outbox.variables ->> 'recoveryRequestId'
          ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN outbox.variables ->> 'recoveryRequestId'
      WHEN outbox.template = 'session-revocation-requested'
        AND outbox.variables ->> 'revocationRequestId'
          ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN outbox.variables ->> 'revocationRequestId'
      WHEN outbox.template IN (
        'inactivity-reminder',
        'inactivity-reminder-followup',
        'inactivity-admin-notice'
      )
        AND outbox.variables ->> 'inactivityPolicyVersion'
          IS NOT DISTINCT FROM 'inactivity-2026-07.v2'
        AND outbox.variables ->> 'inactivityEpisodeId'
          ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN
          CASE outbox.template
            WHEN 'inactivity-reminder'
              THEN (outbox.variables ->> 'inactivityEpisodeId') || ':learner-first'
            WHEN 'inactivity-admin-notice'
              THEN (outbox.variables ->> 'inactivityEpisodeId') || ':admin'
            WHEN 'inactivity-reminder-followup'
              THEN (outbox.variables ->> 'inactivityEpisodeId') || ':learner-second'
          END
      WHEN outbox.variables ->> 'smartReminderPolicyVersion'
        IS NOT DISTINCT FROM 'smart-reminders-2026-07.v1'
        AND outbox.variables ->> 'smartReminderDispatchId'
          ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN 'smart-reminder:' || (outbox.variables ->> 'smartReminderDispatchId')
      ELSE NULL
    END AS legacy_seed,
    CASE
      WHEN outbox.template IN (
        'inactivity-reminder',
        'inactivity-reminder-followup',
        'inactivity-admin-notice'
      )
        THEN 'inactivity-2026-07.v2:' ||
          CASE outbox.template
            WHEN 'inactivity-reminder'
              THEN (outbox.variables ->> 'inactivityEpisodeId') || ':learner-first'
            WHEN 'inactivity-admin-notice'
              THEN (outbox.variables ->> 'inactivityEpisodeId') || ':admin'
            WHEN 'inactivity-reminder-followup'
              THEN (outbox.variables ->> 'inactivityEpisodeId') || ':learner-second'
          END
      WHEN outbox.template = 'reset-password'
        THEN 'reset-password:' || (outbox.variables ->> 'resetVerificationId')
      WHEN outbox.template = 'lost-device-proof'
        THEN outbox.variables ->> 'recoveryRequestId'
      WHEN outbox.template = 'session-revocation-requested'
        THEN outbox.variables ->> 'revocationRequestId'
      WHEN outbox.variables ->> 'smartReminderPolicyVersion'
        IS NOT DISTINCT FROM 'smart-reminders-2026-07.v1'
        THEN 'smart-reminder:' || (outbox.variables ->> 'smartReminderDispatchId')
      ELSE NULL
    END AS stable_event_id
  FROM public.email_outbox AS outbox
  WHERE outbox.user_id IS NOT NULL
),
proven AS (
  SELECT
    candidate.id,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          'mail-event-v1' || pg_catalog.chr(31) ||
          candidate.template || pg_catalog.chr(31) ||
          'a:' || candidate.user_id || pg_catalog.chr(31) ||
          candidate.stable_event_id,
          'UTF8'
        )
      ),
      'hex'
    ) AS idempotency_sha256,
    public.email_outbox_original_payload_sha256(
      candidate.user_id,
      candidate.to_email,
      candidate.template,
      candidate.template_version,
      candidate.variables
    ) AS original_payload_sha256
  FROM account_candidate AS candidate
  WHERE candidate.legacy_seed IS NOT NULL
    AND candidate.stable_event_id IS NOT NULL
    AND candidate.idempotency_key = pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          candidate.template || ':' ||
          pg_catalog.lower(candidate.to_email COLLATE "C") || ':' ||
          candidate.legacy_seed,
          'UTF8'
        )
      ),
      'hex'
    )
)
INSERT INTO pg_temp.mail_outbox_proven_legacy_alias (
  outbox_id,
  idempotency_sha256,
  original_payload_sha256
)
SELECT id, idempotency_sha256, original_payload_sha256
FROM proven;

WITH system_candidate AS (
  SELECT
    outbox.id,
    outbox.idempotency_key,
    outbox.user_id,
    outbox.to_email,
    outbox.template,
    outbox.template_version,
    outbox.variables,
    outbox.variables ->> '_mailProducer' AS producer,
    outbox.variables ->> '_mailSourceId' AS source_id
  FROM public.email_outbox AS outbox
  WHERE outbox.user_id IS NULL
    AND outbox.template = 'access-rejected'
    AND outbox.variables ->> '_mailProducer'
      IS NOT DISTINCT FROM 'access-request-rejected'
    AND outbox.variables ->> '_mailRecipient'
      IS NOT DISTINCT FROM outbox.to_email
    AND outbox.variables ->> '_mailSourceId'
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
),
proven AS (
  SELECT
    candidate.id,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          'mail-event-v1' || pg_catalog.chr(31) ||
          candidate.template || pg_catalog.chr(31) ||
          's:' || candidate.producer || ':' || candidate.source_id ||
          ':requester:' || candidate.source_id || pg_catalog.chr(31) ||
          candidate.source_id,
          'UTF8'
        )
      ),
      'hex'
    ) AS idempotency_sha256,
    public.email_outbox_original_payload_sha256(
      candidate.user_id,
      candidate.to_email,
      candidate.template,
      candidate.template_version,
      candidate.variables
    ) AS original_payload_sha256
  FROM system_candidate AS candidate
  WHERE candidate.idempotency_key = pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        candidate.template || ':' ||
        pg_catalog.lower(candidate.to_email COLLATE "C") || ':' ||
        candidate.source_id,
        'UTF8'
      )
    ),
    'hex'
  )
)
INSERT INTO pg_temp.mail_outbox_proven_legacy_alias (
  outbox_id,
  idempotency_sha256,
  original_payload_sha256
)
SELECT id, idempotency_sha256, original_payload_sha256
FROM proven
ON CONFLICT (outbox_id) DO NOTHING;

WITH proven AS (
  SELECT
    outbox.id,
    pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          'mail-event-v1' || pg_catalog.chr(31) ||
          outbox.template || pg_catalog.chr(31) ||
          'a:' || outbox.user_id || pg_catalog.chr(31) ||
          (outbox.variables ->> 'deletionRunId'),
          'UTF8'
        )
      ),
      'hex'
    ) AS idempotency_sha256,
    public.email_outbox_original_payload_sha256(
      outbox.user_id,
      outbox.to_email,
      outbox.template,
      outbox.template_version,
      outbox.variables
    ) AS original_payload_sha256
  FROM public.email_outbox AS outbox
  WHERE outbox.user_id IS NOT NULL
    AND outbox.template = 'account-deleted'
    AND outbox.variables ->> 'deletionRunId'
      ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND outbox.idempotency_key = pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          'account-deleted:' || outbox.user_id || ':' ||
          (outbox.variables ->> 'deletionRunId'),
          'UTF8'
        )
      ),
      'hex'
    )
)
INSERT INTO pg_temp.mail_outbox_proven_legacy_alias (
  outbox_id,
  idempotency_sha256,
  original_payload_sha256
)
SELECT id, idempotency_sha256, original_payload_sha256
FROM proven
ON CONFLICT (outbox_id) DO NOTHING;

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
        outbox.idempotency_original_payload_sha256 AS original_payload_sha256
      FROM public.email_outbox AS outbox
      UNION ALL
      SELECT alias.idempotency_sha256, alias.original_payload_sha256
      FROM pg_temp.mail_outbox_proven_legacy_alias AS alias
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
$block$;

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
FROM pg_temp.mail_outbox_proven_legacy_alias AS alias;

UPDATE public.email_outbox AS outbox
SET idempotency_authority_version = 'event-v1-alias',
    idempotency_authority_sha256 = alias.idempotency_sha256
FROM pg_temp.mail_outbox_proven_legacy_alias AS alias
WHERE alias.outbox_id = outbox.id;

DROP TABLE pg_temp.mail_outbox_proven_legacy_alias;

ALTER TABLE public.email_outbox
  ALTER COLUMN idempotency_authority_version SET NOT NULL,
  ALTER COLUMN idempotency_original_payload_sha256 SET NOT NULL;
ALTER TABLE public.email_outbox
  ADD CONSTRAINT email_outbox_idempotency_authority_valid
  CHECK (
    idempotency_original_payload_sha256 ~ '^[0-9a-f]{64}$'
    AND (
    (
      idempotency_authority_version = 'event-v1'
      AND idempotency_key ~ '^[0-9a-f]{64}$'
      AND idempotency_authority_sha256 = idempotency_key
    )
    OR (
      idempotency_authority_version = 'event-v1-alias'
      AND idempotency_authority_sha256 ~ '^[0-9a-f]{64}$'
    )
    OR (
      idempotency_authority_version = 'legacy-recipient-v1'
      AND idempotency_authority_sha256 IS NULL
    )
    )
  ) NOT VALID;
ALTER TABLE public.email_outbox
  VALIDATE CONSTRAINT email_outbox_idempotency_authority_valid;

CREATE FUNCTION public.claim_email_outbox_idempotency_authority()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  claimed boolean;
  prior_original_payload_sha256 text;
BEGIN
  IF NEW.idempotency_authority_version IS DISTINCT FROM 'event-v1' THEN
    RAISE EXCEPTION 'new email outbox rows require event-v1 authority'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_idempotency_authority_valid';
  END IF;
  IF NEW.idempotency_authority_sha256 IS NOT NULL THEN
    RAISE EXCEPTION 'email outbox idempotency authority digest is database-owned'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_idempotency_authority_valid';
  END IF;
  IF NEW.idempotency_original_payload_sha256 IS NOT NULL THEN
    RAISE EXCEPTION 'email outbox payload authority digest is database-owned'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_idempotency_authority_valid';
  END IF;
  IF NEW.idempotency_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'event-v1 email outbox idempotency key must be lowercase SHA-256'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_idempotency_authority_valid';
  END IF;

  NEW.idempotency_authority_sha256 := NEW.idempotency_key;
  NEW.idempotency_original_payload_sha256 := public.email_outbox_original_payload_sha256(
    NEW.user_id,
    NEW.to_email,
    NEW.template,
    NEW.template_version,
    NEW.variables
  );

  INSERT INTO public.email_outbox_idempotency_authority (
    idempotency_sha256,
    original_payload_sha256
  )
  VALUES (
    NEW.idempotency_authority_sha256,
    NEW.idempotency_original_payload_sha256
  )
  ON CONFLICT (idempotency_sha256) DO NOTHING
  RETURNING true INTO claimed;

  IF claimed IS TRUE THEN
    RETURN NEW;
  END IF;

  SELECT authority.original_payload_sha256
  INTO prior_original_payload_sha256
  FROM public.email_outbox_idempotency_authority AS authority
  WHERE authority.idempotency_sha256 = NEW.idempotency_authority_sha256;

  IF prior_original_payload_sha256
    IS DISTINCT FROM NEW.idempotency_original_payload_sha256 THEN
    RAISE EXCEPTION 'email outbox idempotency event payload conflict'
      USING ERRCODE = '23505',
            CONSTRAINT = 'email_outbox_idempotency_authority_pkey';
  END IF;
  RETURN NULL;
END
$function$;

CREATE FUNCTION public.enforce_email_outbox_idempotency_metadata_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
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
$function$;

CREATE FUNCTION public.enforce_email_outbox_idempotency_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
  RAISE EXCEPTION 'email outbox idempotency authority is append-only'
    USING ERRCODE = '55000';
END
$function$;

CREATE FUNCTION public.email_outbox_idempotency_coverage_authority(
  candidate_ids uuid[]
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  candidate_count integer;
  unique_count integer;
  covered boolean;
BEGIN
  candidate_count := pg_catalog.cardinality(candidate_ids);
  IF candidate_ids IS NULL
    OR candidate_count IS NULL
    OR candidate_count NOT BETWEEN 1 AND 5000
  THEN
    RAISE EXCEPTION 'invalid email outbox idempotency coverage request'
      USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.count(DISTINCT candidate_id)::integer
  INTO unique_count
  FROM pg_catalog.unnest(candidate_ids) AS input(candidate_id);
  IF unique_count IS DISTINCT FROM candidate_count THEN
    RAISE EXCEPTION 'invalid email outbox idempotency coverage request'
      USING ERRCODE = '22023';
  END IF;

  PERFORM outbox.id
  FROM public.email_outbox AS outbox
  WHERE outbox.id = ANY(candidate_ids)
  ORDER BY outbox.id
  FOR UPDATE OF outbox;

  SELECT
    pg_catalog.count(*) = candidate_count
    AND coalesce(
      pg_catalog.bool_and(
        outbox.idempotency_authority_version IN ('event-v1', 'event-v1-alias')
        AND outbox.idempotency_authority_sha256 ~ '^[0-9a-f]{64}$'
        AND (
          outbox.idempotency_authority_version <> 'event-v1'
          OR outbox.idempotency_authority_sha256 = outbox.idempotency_key
        )
        AND authority.idempotency_sha256
          IS NOT DISTINCT FROM outbox.idempotency_authority_sha256
        AND authority.original_payload_sha256
          IS NOT DISTINCT FROM outbox.idempotency_original_payload_sha256
      ),
      false
    )
  INTO covered
  FROM public.email_outbox AS outbox
  LEFT JOIN public.email_outbox_idempotency_authority AS authority
    ON authority.idempotency_sha256 =
       outbox.idempotency_authority_sha256
  WHERE outbox.id = ANY(candidate_ids);

  RETURN coalesce(covered, false);
END
$function$;

ALTER FUNCTION public.claim_email_outbox_idempotency_authority()
  OWNER TO learncoding_owner;
ALTER FUNCTION public.enforce_email_outbox_idempotency_metadata_immutable()
  OWNER TO learncoding_owner;
ALTER FUNCTION public.enforce_email_outbox_idempotency_append_only()
  OWNER TO learncoding_owner;
ALTER FUNCTION public.email_outbox_idempotency_coverage_authority(uuid[])
  OWNER TO learncoding_owner;

REVOKE ALL ON FUNCTION public.claim_email_outbox_idempotency_authority()
  FROM PUBLIC, learncoding_app, learncoding_worker, learncoding_migrator,
       learncoding_ops, learncoding_owner CASCADE;
REVOKE ALL ON FUNCTION public.enforce_email_outbox_idempotency_metadata_immutable()
  FROM PUBLIC, learncoding_app, learncoding_worker, learncoding_migrator,
       learncoding_ops, learncoding_owner CASCADE;
REVOKE ALL ON FUNCTION public.enforce_email_outbox_idempotency_append_only()
  FROM PUBLIC, learncoding_app, learncoding_worker, learncoding_migrator,
       learncoding_ops, learncoding_owner CASCADE;
REVOKE ALL ON FUNCTION public.email_outbox_idempotency_coverage_authority(uuid[])
  FROM PUBLIC, learncoding_app, learncoding_worker, learncoding_migrator,
       learncoding_ops, learncoding_owner CASCADE;
GRANT EXECUTE ON FUNCTION public.email_outbox_original_payload_sha256(
  text, text, text, text, jsonb
) TO learncoding_owner;
GRANT EXECUTE ON FUNCTION public.claim_email_outbox_idempotency_authority()
  TO learncoding_owner;
GRANT EXECUTE ON FUNCTION public.enforce_email_outbox_idempotency_metadata_immutable()
  TO learncoding_owner;
GRANT EXECUTE ON FUNCTION public.enforce_email_outbox_idempotency_append_only()
  TO learncoding_owner;
GRANT EXECUTE ON FUNCTION public.email_outbox_idempotency_coverage_authority(uuid[])
  TO learncoding_owner;
GRANT EXECUTE ON FUNCTION
  public.email_outbox_idempotency_coverage_authority(uuid[])
  TO learncoding_ops;

REVOKE ALL PRIVILEGES
  ON TABLE public.email_outbox_idempotency_authority
  FROM PUBLIC, learncoding_app, learncoding_worker, learncoding_migrator,
       learncoding_ops, learncoding_owner CASCADE;
GRANT ALL PRIVILEGES ON TABLE public.email_outbox_idempotency_authority
  TO learncoding_owner;

DO $block$
DECLARE
  grantee_name text;
BEGIN
  FOR grantee_name IN
    SELECT DISTINCT pg_catalog.pg_get_userbyid(privilege.grantee)
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      coalesce(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS privilege
    WHERE relation.oid =
      'public.email_outbox_idempotency_authority'::pg_catalog.regclass
      AND privilege.grantee <> 0
      AND privilege.grantee <> relation.relowner
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE public.email_outbox_idempotency_authority FROM %I CASCADE',
      grantee_name
    );
  END LOOP;
END
$block$;

DO $block$
DECLARE
  routine_record record;
  grantee_name text;
BEGIN
  FOR routine_record IN
    SELECT routine.oid, routine.proowner,
           pg_catalog.oidvectortypes(routine.proargtypes) AS argument_types
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    WHERE namespace.nspname = 'public'
      AND routine.proname IN (
        'email_outbox_original_payload_sha256',
        'claim_email_outbox_idempotency_authority',
        'enforce_email_outbox_idempotency_metadata_immutable',
        'enforce_email_outbox_idempotency_append_only',
        'email_outbox_idempotency_coverage_authority'
      )
  LOOP
    FOR grantee_name IN
      SELECT DISTINCT pg_catalog.pg_get_userbyid(privilege.grantee)
      FROM pg_catalog.pg_proc AS selected_routine
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        coalesce(
          selected_routine.proacl,
          pg_catalog.acldefault('f', selected_routine.proowner)
        )
      ) AS privilege
      WHERE selected_routine.oid = routine_record.oid
        AND privilege.grantee <> 0
        AND privilege.grantee <> selected_routine.proowner
        AND NOT (
          selected_routine.proname =
            'email_outbox_idempotency_coverage_authority'
          AND pg_catalog.pg_get_userbyid(privilege.grantee) =
            'learncoding_ops'
        )
    LOOP
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION public.%I(%s) FROM %I CASCADE',
        (
          SELECT routine.proname
          FROM pg_catalog.pg_proc AS routine
          WHERE routine.oid = routine_record.oid
        ),
        routine_record.argument_types,
        grantee_name
      );
    END LOOP;
  END LOOP;
END
$block$;

REVOKE ALL (
  idempotency_authority_version,
  idempotency_authority_sha256,
  idempotency_original_payload_sha256
) ON TABLE public.email_outbox
  FROM PUBLIC, learncoding_app, learncoding_worker, learncoding_migrator,
       learncoding_ops, learncoding_owner CASCADE;

DO $block$
DECLARE
  grantee_name text;
BEGIN
  FOR grantee_name IN
    SELECT DISTINCT pg_catalog.pg_get_userbyid(privilege.grantee)
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS privilege
    WHERE attribute.attrelid = 'public.email_outbox'::pg_catalog.regclass
      AND attribute.attname IN (
        'idempotency_authority_version',
        'idempotency_authority_sha256',
        'idempotency_original_payload_sha256'
      )
      AND privilege.grantee <> 0
      AND privilege.grantee <> (
        SELECT relation.relowner
        FROM pg_catalog.pg_class AS relation
        WHERE relation.oid = attribute.attrelid
      )
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL (%I, %I, %I) ON TABLE public.email_outbox FROM %I CASCADE',
      'idempotency_authority_version',
      'idempotency_authority_sha256',
      'idempotency_original_payload_sha256',
      grantee_name
    );
  END LOOP;
END
$block$;

-- The worker's pre-existing INSERT grant is column-scoped. It needs the
-- caller-supplied version marker, but the two digest columns remain DB-owned.
GRANT INSERT (idempotency_authority_version)
  ON TABLE public.email_outbox
  TO learncoding_worker;

CREATE TRIGGER email_outbox_idempotency_claim
BEFORE INSERT ON public.email_outbox
FOR EACH ROW
EXECUTE FUNCTION public.claim_email_outbox_idempotency_authority();

CREATE TRIGGER email_outbox_idempotency_metadata_immutable
BEFORE UPDATE OF
  idempotency_key,
  idempotency_authority_version,
  idempotency_authority_sha256,
  idempotency_original_payload_sha256
ON public.email_outbox
FOR EACH ROW
EXECUTE FUNCTION public.enforce_email_outbox_idempotency_metadata_immutable();

CREATE TRIGGER email_outbox_idempotency_append_only
BEFORE UPDATE OR DELETE
ON public.email_outbox_idempotency_authority
FOR EACH ROW
EXECUTE FUNCTION public.enforce_email_outbox_idempotency_append_only();

CREATE TRIGGER email_outbox_idempotency_no_truncate
BEFORE TRUNCATE
ON public.email_outbox_idempotency_authority
FOR EACH STATEMENT
EXECUTE FUNCTION public.enforce_email_outbox_idempotency_append_only();
