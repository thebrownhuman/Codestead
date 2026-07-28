type QueryResult = Readonly<{
  rows: readonly Record<string, unknown>[];
}>;

export type DisposableIntegrationResetInstallerClient = Readonly<{
  query: (statement: string) => PromiseLike<QueryResult>;
}>;

type DisposableIntegrationResetLifecycleClient =
  DisposableIntegrationResetInstallerClient & Readonly<{
    release: (destroy?: boolean) => void;
  }>;

export type DisposableIntegrationResetLifecyclePool = Readonly<{
  connect: () => PromiseLike<DisposableIntegrationResetLifecycleClient>;
  end: () => PromiseLike<void>;
}>;

const EXPECTED_DATABASE = "learncoding_integration";
const EXPECTED_INTEGRATION_USER = "learncoding_it";
const INSTALLER_TRANSACTION_TIMEOUT_SQL = `
SET LOCAL lock_timeout = '5000ms';
SET LOCAL statement_timeout = '30000ms';
SET LOCAL idle_in_transaction_session_timeout = '30000ms'
`;

const RESET_NAMESPACE_OBJECT_CONTRACT_SQL = String.raw`
(
  (
    SELECT pg_catalog.count(*) = 1
           AND pg_catalog.bool_and(
             pg_catalog.pg_get_userbyid(namespace.nspowner)
               = 'learncoding_owner'
             AND pg_catalog.pg_get_userbyid(routine.proowner)
               = 'learncoding_owner'
             AND routine.prosecdef IS TRUE
             AND routine.proconfig
                   = ARRAY['search_path=pg_catalog']::pg_catalog.text[]
           )
      FROM pg_catalog.pg_namespace AS namespace
      JOIN pg_catalog.pg_proc AS routine
        ON routine.oid = pg_catalog.to_regprocedure(
             'codestead_disposable_test.reset_database()'
           )
       AND routine.pronamespace = namespace.oid
     WHERE namespace.nspname = 'codestead_disposable_test'
  )
  AND (
    SELECT pg_catalog.count(*) = 1
      FROM pg_catalog.pg_proc AS schema_routine
     WHERE schema_routine.pronamespace = pg_catalog.to_regnamespace(
             'codestead_disposable_test'
           )
  )
  AND NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_aggregate AS aggregate_row
      JOIN pg_catalog.pg_proc AS aggregate_routine
        ON aggregate_routine.oid = aggregate_row.aggfnoid
     WHERE aggregate_routine.pronamespace = pg_catalog.to_regnamespace(
             'codestead_disposable_test'
           )
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS schema_object
     WHERE schema_object.relnamespace = pg_catalog.to_regnamespace(
             'codestead_disposable_test'
           )
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_collation AS schema_object
     WHERE schema_object.collnamespace = pg_catalog.to_regnamespace(
             'codestead_disposable_test'
           )
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS schema_object
     WHERE schema_object.connamespace = pg_catalog.to_regnamespace(
             'codestead_disposable_test'
           )
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_conversion AS schema_object
     WHERE schema_object.connamespace = pg_catalog.to_regnamespace(
             'codestead_disposable_test'
           )
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_default_acl AS schema_object
     WHERE schema_object.defaclnamespace = pg_catalog.to_regnamespace(
             'codestead_disposable_test'
           )
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_extension AS schema_object
     WHERE schema_object.extnamespace = pg_catalog.to_regnamespace(
             'codestead_disposable_test'
           )
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_opclass AS schema_object
     WHERE schema_object.opcnamespace = pg_catalog.to_regnamespace(
             'codestead_disposable_test'
           )
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_operator AS schema_object
     WHERE schema_object.oprnamespace = pg_catalog.to_regnamespace(
             'codestead_disposable_test'
           )
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_opfamily AS schema_object
     WHERE schema_object.opfnamespace = pg_catalog.to_regnamespace(
             'codestead_disposable_test'
           )
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_publication_namespace AS schema_object
     WHERE schema_object.pnnspid = pg_catalog.to_regnamespace(
             'codestead_disposable_test'
           )
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_statistic_ext AS schema_object
     WHERE schema_object.stxnamespace = pg_catalog.to_regnamespace(
             'codestead_disposable_test'
           )
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_ts_config AS schema_object
     WHERE schema_object.cfgnamespace = pg_catalog.to_regnamespace(
             'codestead_disposable_test'
           )
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_ts_dict AS schema_object
     WHERE schema_object.dictnamespace = pg_catalog.to_regnamespace(
             'codestead_disposable_test'
           )
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_ts_parser AS schema_object
     WHERE schema_object.prsnamespace = pg_catalog.to_regnamespace(
             'codestead_disposable_test'
           )
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_ts_template AS schema_object
     WHERE schema_object.tmplnamespace = pg_catalog.to_regnamespace(
             'codestead_disposable_test'
           )
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_type AS schema_object
     WHERE schema_object.typnamespace = pg_catalog.to_regnamespace(
             'codestead_disposable_test'
           )
  )
  AND NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_description AS metadata
     WHERE (metadata.classoid, metadata.objoid, metadata.objsubid) IN (
       (
         'pg_catalog.pg_namespace'::pg_catalog.regclass,
         pg_catalog.to_regnamespace('codestead_disposable_test'),
         0
       ),
       (
         'pg_catalog.pg_proc'::pg_catalog.regclass,
         pg_catalog.to_regprocedure(
           'codestead_disposable_test.reset_database()'
         ),
         0
       )
     )
  )
  AND NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_seclabel AS metadata
     WHERE (metadata.classoid, metadata.objoid, metadata.objsubid) IN (
       (
         'pg_catalog.pg_namespace'::pg_catalog.regclass,
         pg_catalog.to_regnamespace('codestead_disposable_test'),
         0
       ),
       (
         'pg_catalog.pg_proc'::pg_catalog.regclass,
         pg_catalog.to_regprocedure(
           'codestead_disposable_test.reset_database()'
         ),
         0
       )
     )
  )
  AND NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_init_privs AS metadata
     WHERE (metadata.classoid, metadata.objoid, metadata.objsubid) IN (
       (
         'pg_catalog.pg_namespace'::pg_catalog.regclass,
         pg_catalog.to_regnamespace('codestead_disposable_test'),
         0
       ),
       (
         'pg_catalog.pg_proc'::pg_catalog.regclass,
         pg_catalog.to_regprocedure(
           'codestead_disposable_test.reset_database()'
         ),
         0
       )
     )
  )
  AND (
    SELECT pg_catalog.count(*) = 3
           AND pg_catalog.bool_and(
             access.grantor = namespace.nspowner
             AND access.is_grantable IS FALSE
             AND (
               (
                 access.grantee = namespace.nspowner
                 AND access.privilege_type IN ('CREATE', 'USAGE')
               )
               OR (
                 pg_catalog.pg_get_userbyid(access.grantee)
                   = 'learncoding_app'
                 AND access.privilege_type = 'USAGE'
               )
             )
           )
      FROM pg_catalog.pg_namespace AS namespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          namespace.nspacl,
          pg_catalog.acldefault('n', namespace.nspowner)
        )
      ) AS access
     WHERE namespace.nspname = 'codestead_disposable_test'
  )
  AND (
    SELECT pg_catalog.count(*) = 1
           AND pg_catalog.bool_and(
             access.grantor = routine.proowner
             AND pg_catalog.pg_get_userbyid(access.grantee)
                   = 'learncoding_app'
             AND access.privilege_type = 'EXECUTE'
             AND access.is_grantable IS FALSE
           )
      FROM pg_catalog.pg_proc AS routine
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          routine.proacl,
          pg_catalog.acldefault('f', routine.proowner)
        )
      ) AS access
     WHERE routine.oid = pg_catalog.to_regprocedure(
             'codestead_disposable_test.reset_database()'
           )
  )
)
`;

const RESET_NAMESPACE_DEPENDENCY_CONTRACT_SQL = String.raw`
(
  (
    SELECT pg_catalog.count(*) = 1
           AND pg_catalog.bool_and(
             dependency.classid
               = 'pg_catalog.pg_proc'::pg_catalog.regclass
             AND dependency.objid = pg_catalog.to_regprocedure(
                   'codestead_disposable_test.reset_database()'
                 )
             AND dependency.objsubid = 0
             AND dependency.deptype = 'n'
             AND dependency.refobjsubid = 0
           )
      FROM pg_catalog.pg_depend AS dependency
     WHERE dependency.refclassid
             = 'pg_catalog.pg_namespace'::pg_catalog.regclass
       AND dependency.refobjid = pg_catalog.to_regnamespace(
             'codestead_disposable_test'
           )
  )
  AND NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_depend AS dependent
     WHERE dependent.refclassid
             = 'pg_catalog.pg_proc'::pg_catalog.regclass
       AND dependent.refobjid = pg_catalog.to_regprocedure(
             'codestead_disposable_test.reset_database()'
           )
       AND dependent.refobjsubid = 0
  )
  AND (
    WITH reset_function AS (
      SELECT routine.oid AS routine_oid
        FROM pg_catalog.pg_proc AS routine
       WHERE routine.oid = pg_catalog.to_regprocedure(
               'codestead_disposable_test.reset_database()'
             )
    ), reset_namespace AS (
      SELECT namespace.oid AS namespace_oid
        FROM pg_catalog.pg_namespace AS namespace
       WHERE namespace.nspname = 'codestead_disposable_test'
    ), plpgsql_language AS (
      SELECT language.oid AS language_oid
        FROM pg_catalog.pg_language AS language
       WHERE language.lanname = 'plpgsql'
    ), observed_outgoing_dependencies AS (
      SELECT dependency.classid,
             dependency.objid,
             dependency.objsubid,
             dependency.refclassid,
             dependency.refobjid,
             dependency.refobjsubid,
             dependency.deptype
        FROM pg_catalog.pg_depend AS dependency
        JOIN reset_function AS target
          ON dependency.classid
               = 'pg_catalog.pg_proc'::pg_catalog.regclass
         AND dependency.objid = target.routine_oid
    ), expected_outgoing_dependencies AS (
      SELECT 'pg_catalog.pg_proc'::pg_catalog.regclass AS classid,
             target.routine_oid AS objid,
             0::pg_catalog.int4 AS objsubid,
             'pg_catalog.pg_namespace'::pg_catalog.regclass AS refclassid,
             namespace.namespace_oid AS refobjid,
             0::pg_catalog.int4 AS refobjsubid,
             'n'::"char" AS deptype
        FROM reset_function AS target
        CROSS JOIN reset_namespace AS namespace
      UNION ALL
      SELECT 'pg_catalog.pg_proc'::pg_catalog.regclass,
             target.routine_oid,
             0::pg_catalog.int4,
             'pg_catalog.pg_language'::pg_catalog.regclass,
             language.language_oid,
             0::pg_catalog.int4,
             'n'::"char"
        FROM reset_function AS target
        CROSS JOIN plpgsql_language AS language
    )
    SELECT NOT EXISTS (
      (
        SELECT observed.classid,
               observed.objid,
               observed.objsubid,
               observed.refclassid,
               observed.refobjid,
               observed.refobjsubid,
               observed.deptype
          FROM observed_outgoing_dependencies AS observed
        EXCEPT ALL
        SELECT expected.classid,
               expected.objid,
               expected.objsubid,
               expected.refclassid,
               expected.refobjid,
               expected.refobjsubid,
               expected.deptype
          FROM expected_outgoing_dependencies AS expected
      )
      UNION ALL
      (
        SELECT expected.classid,
               expected.objid,
               expected.objsubid,
               expected.refclassid,
               expected.refobjid,
               expected.refobjsubid,
               expected.deptype
          FROM expected_outgoing_dependencies AS expected
        EXCEPT ALL
        SELECT observed.classid,
               observed.objid,
               observed.objsubid,
               observed.refclassid,
               observed.refobjid,
               observed.refobjsubid,
               observed.deptype
          FROM observed_outgoing_dependencies AS observed
      )
    )
  )
)
`;
const RESET_GUARD_CONTRACT_SQL = String.raw`
  SELECT ${RESET_NAMESPACE_OBJECT_CONTRACT_SQL},
         ${RESET_NAMESPACE_DEPENDENCY_CONTRACT_SQL}
    INTO reset_namespace_contract_exact,
         namespace_dependency_contract_exact;

  WITH expected_routines(
    identity,
    routine_name,
    security_definer,
    settings,
    source_sha256,
    definition_sha256
  ) AS (
    VALUES
      (
        'public.reject_backup_status_mail_authority_mutation()'
          ::pg_catalog.text,
        'reject_backup_status_mail_authority_mutation'::pg_catalog.text,
        false,
        ARRAY['search_path=pg_catalog']::pg_catalog.text[],
        '821807d9e78e8d31b0c6ebb567a51c92f04830848de2d555e4f8be8fd370c0db'
          ::pg_catalog.text,
        '30414dca0ae964f5275372bc0c8f1607417c0fa5d22786977b25c21be877d240'
          ::pg_catalog.text
      ),
      (
        'public.enforce_email_outbox_idempotency_append_only()'
          ::pg_catalog.text,
        'enforce_email_outbox_idempotency_append_only'::pg_catalog.text,
        true,
        ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[],
        '164b71af1bca387a599b64246851b7ba3e66c8a9557a60581dec54eb4d757370'
          ::pg_catalog.text,
        '2ae733ebe79975ce70fa9427ccb92295ecf8acad75797e8541bbb15bd9318790'
          ::pg_catalog.text
      ),
      (
        'public.enforce_mail_delivery_release_receipt_append_only()'
          ::pg_catalog.text,
        'enforce_mail_delivery_release_receipt_append_only'::pg_catalog.text,
        true,
        ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[],
        'ba3b8d7a3dd78f927778d41856c8c57430d188de2c3b05f8a7c3173776bed131'
          ::pg_catalog.text,
        '88e9e02ba13bfd210a724e56e6216c9e0375c046b6d904307d51c50cbae4cd3a'
          ::pg_catalog.text
      )
  ),
  actual_routines AS (
    SELECT
      expected.*,
      routine.oid AS routine_oid,
      pg_catalog.pg_get_userbyid(routine.proowner) AS owner_name,
      language.lanname AS language_name,
      routine.prokind,
      routine.provolatile,
      routine.proisstrict,
      routine.proparallel,
      routine.proleakproof,
      routine.prosecdef,
      routine.proconfig,
      routine.prorettype,
      routine.proretset,
      routine.pronargs,
      routine.pronargdefaults,
      routine.proargdefaults,
      routine.provariadic,
      routine.procost,
      routine.prorows,
      routine.prosupport,
      routine.protrftypes,
      routine.probin,
      routine.prosqlbody,
      pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(routine.prosrc, 'UTF8')),
        'hex'
      ) AS actual_source_sha256,
      pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(
            pg_catalog.pg_get_functiondef(routine.oid),
            'UTF8'
          )
        ),
        'hex'
      ) AS actual_definition_sha256,
      COALESCE((
        SELECT pg_catalog.array_agg(
                 serialized.acl_entry ORDER BY serialized.acl_entry
               )
          FROM (
            SELECT pg_catalog.concat_ws(
                     '|',
                     CASE WHEN access.grantee = 0 THEN 'PUBLIC'
                          ELSE pg_catalog.pg_get_userbyid(access.grantee) END,
                     CASE WHEN access.grantor = 0 THEN 'PUBLIC'
                          ELSE pg_catalog.pg_get_userbyid(access.grantor) END,
                     pg_catalog.lower(access.privilege_type),
                     access.is_grantable
                   ) AS acl_entry
              FROM pg_catalog.aclexplode(
                     COALESCE(
                       routine.proacl,
                       pg_catalog.acldefault('f', routine.proowner)
                     )
                   ) AS access
          ) AS serialized
      ), ARRAY[]::pg_catalog.text[]) AS actual_execute_acl,
      (
        SELECT pg_catalog.count(*)
          FROM pg_catalog.pg_proc AS overload
         WHERE overload.pronamespace =
                 'public'::pg_catalog.regnamespace
           AND overload.proname = expected.routine_name
      ) AS overload_count
      FROM expected_routines AS expected
      LEFT JOIN pg_catalog.pg_proc AS routine
        ON routine.oid = pg_catalog.to_regprocedure(expected.identity)
      LEFT JOIN pg_catalog.pg_language AS language
        ON language.oid = routine.prolang
  )
  SELECT pg_catalog.count(*) = 3
         AND pg_catalog.bool_and(COALESCE(
           actual.routine_oid IS NOT NULL
           AND actual.owner_name = 'learncoding_owner'
           AND actual.language_name = 'plpgsql'
           AND actual.prokind = 'f'
           AND actual.provolatile = 'v'
           AND actual.proisstrict IS FALSE
           AND actual.proparallel = 'u'
           AND actual.proleakproof IS FALSE
           AND actual.prosecdef = actual.security_definer
           AND actual.proconfig IS NOT DISTINCT FROM actual.settings
           AND actual.prorettype =
                 'pg_catalog.trigger'::pg_catalog.regtype
           AND actual.proretset IS FALSE
           AND actual.pronargs = 0
           AND actual.pronargdefaults = 0
           AND actual.proargdefaults IS NULL
           AND actual.provariadic = 0
           AND actual.procost = 100
           AND actual.prorows = 0
           AND actual.prosupport = 0
           AND actual.protrftypes IS NULL
           AND actual.probin IS NULL
           AND actual.prosqlbody IS NULL
           AND actual.actual_source_sha256 = actual.source_sha256
           AND actual.actual_definition_sha256 = actual.definition_sha256
           AND actual.actual_execute_acl IS NOT DISTINCT FROM ARRAY[
             'learncoding_owner|learncoding_owner|execute|f'
           ]::pg_catalog.text[]
           AND actual.overload_count = 1,
           false
         ))
    INTO routine_contract_exact
    FROM actual_routines AS actual;

  WITH expected_triggers(
    relation_id, trigger_name, enabled_mode, trigger_type, routine_id
  ) AS (
    VALUES
      (
        'public.backup_status_mail_authority'::pg_catalog.regclass,
        'backup_status_mail_authority_no_truncate'::pg_catalog.text,
        'O'::pg_catalog."char",
        34::pg_catalog.int2,
        'public.reject_backup_status_mail_authority_mutation()'
          ::pg_catalog.regprocedure
      ),
      (
        'public.email_outbox_idempotency_authority'::pg_catalog.regclass,
        'email_outbox_idempotency_no_truncate'::pg_catalog.text,
        'A'::pg_catalog."char",
        34::pg_catalog.int2,
        'public.enforce_email_outbox_idempotency_append_only()'
          ::pg_catalog.regprocedure
      ),
      (
        'public.mail_delivery_release_receipt'::pg_catalog.regclass,
        'mail_delivery_release_receipt_no_truncate'::pg_catalog.text,
        'A'::pg_catalog."char",
        34::pg_catalog.int2,
        'public.enforce_mail_delivery_release_receipt_append_only()'
          ::pg_catalog.regprocedure
      )
  )
  SELECT pg_catalog.count(candidate.oid) = 3
         AND pg_catalog.bool_and(COALESCE(
           candidate.tgenabled = expected.enabled_mode
           AND candidate.tgtype = expected.trigger_type
           AND candidate.tgfoid = expected.routine_id
           AND candidate.tgisinternal IS FALSE
           AND candidate.tgconstraint = 0
           AND candidate.tgconstrrelid = 0
           AND candidate.tgconstrindid = 0
           AND candidate.tgparentid = 0
           AND candidate.tgdeferrable IS FALSE
           AND candidate.tginitdeferred IS FALSE
           AND candidate.tgqual IS NULL
           AND candidate.tgoldtable IS NULL
           AND candidate.tgnewtable IS NULL
           AND candidate.tgnargs = 0
           AND pg_catalog.octet_length(candidate.tgargs) = 0
           AND candidate.tgattr = ''::pg_catalog.int2vector,
           false
         ))
    INTO trigger_contract_exact
    FROM expected_triggers AS expected
    LEFT JOIN pg_catalog.pg_trigger AS candidate
      ON candidate.tgrelid = expected.relation_id
     AND candidate.tgname = expected.trigger_name;

  SELECT pg_catalog.count(*) = 1
         AND pg_catalog.bool_and(
           guard.singleton IS TRUE
           AND guard.authority_epoch
             <> '00000000-0000-0000-0000-000000000000'::pg_catalog.uuid
         )
    INTO guard_exact
    FROM ONLY public.backup_status_mail_admin_guard AS guard;
`;

const INSTALL_RESET_SQL = String.raw`
CREATE SCHEMA codestead_disposable_test AUTHORIZATION learncoding_owner;
REVOKE ALL ON SCHEMA codestead_disposable_test
  FROM PUBLIC, learncoding_it, learncoding_app, learncoding_worker,
       learncoding_migrator, learncoding_ops, learncoding_backup_reporter;

CREATE FUNCTION codestead_disposable_test.reset_database()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $codestead_disposable_reset$
DECLARE
  application_tables pg_catalog.text;
  guard_exact pg_catalog.bool;
  lock_acquired pg_catalog.bool;
  lock_deadline pg_catalog.timestamptz;
  namespace_dependency_contract_exact pg_catalog.bool;
  reset_namespace_contract_exact pg_catalog.bool;
  routine_contract_exact pg_catalog.bool;
  trigger_contract_exact pg_catalog.bool;
BEGIN
  IF current_database() IS DISTINCT FROM 'learncoding_integration'
     OR session_user IS DISTINCT FROM 'learncoding_app'
     OR current_user IS DISTINCT FROM 'learncoding_owner' THEN
    RAISE EXCEPTION 'disposable integration reset authority mismatch'
      USING ERRCODE = '42501';
  END IF;

  PERFORM pg_catalog.set_config('lock_timeout', '5000ms', true);
  lock_deadline :=
    pg_catalog.clock_timestamp() + '5 seconds'::pg_catalog.interval;
  LOOP
    lock_acquired := pg_catalog.pg_try_advisory_xact_lock(
      1129272147,
      1381254228
    );
    EXIT WHEN lock_acquired;
    IF pg_catalog.clock_timestamp() >= lock_deadline THEN
      RAISE EXCEPTION 'disposable integration reset lock deadline exceeded'
        USING ERRCODE = '55P03';
    END IF;
    PERFORM pg_catalog.pg_sleep(0.01);
  END LOOP;

${RESET_GUARD_CONTRACT_SQL}
  IF routine_contract_exact IS NOT TRUE
     OR trigger_contract_exact IS NOT TRUE
     OR reset_namespace_contract_exact IS NOT TRUE
     OR namespace_dependency_contract_exact IS NOT TRUE
     OR guard_exact IS NOT TRUE THEN
    RAISE EXCEPTION 'disposable integration reset guard contract mismatch'
      USING ERRCODE = '23514';
  END IF;

  ALTER TABLE ONLY public.backup_status_mail_authority
    DISABLE TRIGGER backup_status_mail_authority_no_truncate;
  ALTER TABLE ONLY public.email_outbox_idempotency_authority
    DISABLE TRIGGER email_outbox_idempotency_no_truncate;
  ALTER TABLE ONLY public.mail_delivery_release_receipt
    DISABLE TRIGGER mail_delivery_release_receipt_no_truncate;

  SELECT pg_catalog.string_agg(
           pg_catalog.format('%I.%I', tables.table_schema, tables.table_name),
           ', ' ORDER BY tables.table_schema, tables.table_name
         )
    INTO application_tables
    FROM information_schema.tables AS tables
   WHERE tables.table_schema = 'public'
     AND tables.table_type = 'BASE TABLE';

  IF application_tables IS NOT NULL THEN
    EXECUTE pg_catalog.format(
      'TRUNCATE TABLE %s RESTART IDENTITY CASCADE',
      application_tables
    );
  END IF;

  INSERT INTO public.backup_status_mail_admin_guard (singleton)
  VALUES (TRUE);

  ALTER TABLE ONLY public.backup_status_mail_authority
    ENABLE TRIGGER backup_status_mail_authority_no_truncate;
  ALTER TABLE ONLY public.email_outbox_idempotency_authority
    ENABLE ALWAYS TRIGGER email_outbox_idempotency_no_truncate;
  ALTER TABLE ONLY public.mail_delivery_release_receipt
    ENABLE ALWAYS TRIGGER mail_delivery_release_receipt_no_truncate;

${RESET_GUARD_CONTRACT_SQL}
  IF routine_contract_exact IS NOT TRUE
     OR trigger_contract_exact IS NOT TRUE
     OR reset_namespace_contract_exact IS NOT TRUE
     OR namespace_dependency_contract_exact IS NOT TRUE
     OR guard_exact IS NOT TRUE THEN
    RAISE EXCEPTION 'disposable integration reset restoration mismatch'
      USING ERRCODE = '23514';
  END IF;
END
$codestead_disposable_reset$;

ALTER FUNCTION codestead_disposable_test.reset_database()
  OWNER TO learncoding_owner;
REVOKE ALL ON FUNCTION codestead_disposable_test.reset_database()
  FROM PUBLIC, learncoding_owner, learncoding_it, learncoding_app,
       learncoding_worker, learncoding_migrator, learncoding_ops,
       learncoding_backup_reporter;
GRANT CREATE, USAGE ON SCHEMA codestead_disposable_test
  TO learncoding_owner;
GRANT USAGE ON SCHEMA codestead_disposable_test TO learncoding_app;
GRANT EXECUTE ON FUNCTION codestead_disposable_test.reset_database()
  TO learncoding_app;
`;
const INSTALLER_IDENTITY_SQL = `
SELECT current_database() AS current_database,
       current_user AS current_user,
       session_user AS session_user,
       roles.rolsuper AS is_superuser
  FROM pg_catalog.pg_roles AS roles
 WHERE roles.rolname = current_user
`;

const INSTALLATION_CONTRACT_SQL = `
SELECT (
  pg_catalog.pg_get_userbyid(namespace.nspowner) = 'learncoding_owner'
  AND routine.prosecdef IS TRUE
  AND routine.prokind = 'f'
  AND routine.provolatile = 'v'
  AND routine.proisstrict IS FALSE
  AND routine.proparallel = 'u'
  AND routine.proleakproof IS FALSE
  AND routine.pronargs = 0
  AND routine.pronargdefaults = 0
  AND routine.proargdefaults IS NULL
  AND routine.provariadic = 0
  AND routine.prorettype = 'pg_catalog.void'::pg_catalog.regtype
  AND routine.proretset IS FALSE
  AND routine.procost = 100
  AND routine.prorows = 0
  AND routine.prosupport = 0
  AND routine.protrftypes IS NULL
  AND routine.probin IS NULL
  AND routine.prosqlbody IS NULL
  AND pg_catalog.pg_get_function_identity_arguments(routine.oid) = ''
  AND pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(routine.prosrc, 'UTF8')
        ),
        'hex'
      ) = '60a1d822198e816fdce2192f5cc290d27f54d915b76df37eb35ccc7ab0a432d2'
  AND pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(
            pg_catalog.pg_get_functiondef(routine.oid),
            'UTF8'
          )
        ),
        'hex'
      ) = 'de5f97b3c4de07bf19c766a7fe11ed0bf78b983daf00c803f0cba62a3753b18d'
  AND pg_catalog.pg_get_userbyid(routine.proowner) = 'learncoding_owner'
  AND language.lanname = 'plpgsql'
  AND routine.proconfig = ARRAY['search_path=pg_catalog']::pg_catalog.text[]
  AND (
    SELECT pg_catalog.count(*) = 1
      FROM pg_catalog.pg_proc AS schema_routine
     WHERE schema_routine.pronamespace = namespace.oid
  )
  AND (
    SELECT pg_catalog.count(*) = 1
      FROM pg_catalog.pg_proc AS overload
     WHERE overload.pronamespace = namespace.oid
       AND overload.proname = 'reset_database'
  )
  AND NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS schema_relation
     WHERE schema_relation.relnamespace = namespace.oid
  )
  AND NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_type AS schema_type
     WHERE schema_type.typnamespace = namespace.oid
  )
  AND (
    SELECT pg_catalog.count(*) = 3
           AND pg_catalog.bool_and(
             access.grantor = namespace.nspowner
             AND access.is_grantable IS FALSE
             AND (
               (
                 access.grantee = namespace.nspowner
                 AND access.privilege_type IN ('CREATE', 'USAGE')
               )
               OR (
                 pg_catalog.pg_get_userbyid(access.grantee) = 'learncoding_app'
                 AND access.privilege_type = 'USAGE'
               )
             )
           )
           AND pg_catalog.bool_or(
             pg_catalog.pg_get_userbyid(access.grantee) = 'learncoding_app'
             AND access.privilege_type = 'USAGE'
           )
      FROM pg_catalog.aclexplode(
        COALESCE(
          namespace.nspacl,
          pg_catalog.acldefault('n', namespace.nspowner)
        )
      ) AS access
  )
  AND (
    SELECT pg_catalog.count(*) = 1
           AND pg_catalog.bool_and(
             access.grantor = routine.proowner
             AND access.privilege_type = 'EXECUTE'
             AND access.is_grantable IS FALSE
             AND pg_catalog.pg_get_userbyid(access.grantee)
                   = 'learncoding_app'
           )
           AND pg_catalog.bool_or(
             pg_catalog.pg_get_userbyid(access.grantee) = 'learncoding_app'
           )
      FROM pg_catalog.aclexplode(
        COALESCE(
          routine.proacl,
          pg_catalog.acldefault('f', routine.proowner)
        )
      ) AS access
  )
  AND ${RESET_NAMESPACE_OBJECT_CONTRACT_SQL}
  AND ${RESET_NAMESPACE_DEPENDENCY_CONTRACT_SQL}
) AS contract_installed
  FROM pg_catalog.pg_namespace AS namespace
  JOIN pg_catalog.pg_proc AS routine
    ON routine.pronamespace = namespace.oid
   AND routine.proname = 'reset_database'
  JOIN pg_catalog.pg_language AS language
    ON language.oid = routine.prolang
 WHERE namespace.nspname = 'codestead_disposable_test'
`;

const ABSENCE_CONTRACT_SQL = `
SELECT (
  pg_catalog.to_regnamespace('codestead_disposable_test') IS NULL
  AND pg_catalog.to_regprocedure(
        'codestead_disposable_test.reset_database()'
      ) IS NULL
  AND NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_namespace AS namespace
     WHERE namespace.nspname = 'codestead_disposable_test'
  )
) AS contract_absent
`;
async function rollbackAfterFailure(
  client: DisposableIntegrationResetInstallerClient,
  primaryError: unknown,
): Promise<never> {
  try {
    await client.query("ROLLBACK");
  } catch (rollbackError) {
    throw new AggregateError(
      [primaryError, rollbackError],
      "disposable integration reset installation rollback failed",
    );
  }
  throw primaryError;
}

export async function installDisposableIntegrationReset(
  client: DisposableIntegrationResetInstallerClient,
): Promise<void> {
  try {
    await client.query("BEGIN");
    await client.query(INSTALLER_TRANSACTION_TIMEOUT_SQL);
    const identity = await client.query(INSTALLER_IDENTITY_SQL);
    const row = identity.rows[0];
    if (
      identity.rows.length !== 1
      || row?.current_database !== EXPECTED_DATABASE
      || row.current_user !== EXPECTED_INTEGRATION_USER
      || row.session_user !== EXPECTED_INTEGRATION_USER
      || row.is_superuser !== true
    ) {
      throw new Error(
        "disposable integration reset installer identity mismatch",
      );
    }

    await client.query(INSTALL_RESET_SQL);
    const verification = await client.query(INSTALLATION_CONTRACT_SQL);
    if (
      verification.rows.length !== 1
      || verification.rows[0]?.contract_installed !== true
    ) {
      throw new Error(
        "disposable integration reset installation verification failed",
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await rollbackAfterFailure(client, error);
  }
}
export async function uninstallDisposableIntegrationReset(
  client: DisposableIntegrationResetInstallerClient,
): Promise<void> {
  try {
    await client.query("BEGIN");
    await client.query(INSTALLER_TRANSACTION_TIMEOUT_SQL);
    const identity = await client.query(INSTALLER_IDENTITY_SQL);
    const row = identity.rows[0];
    if (
      identity.rows.length !== 1
      || row?.current_database !== EXPECTED_DATABASE
      || row.current_user !== EXPECTED_INTEGRATION_USER
      || row.session_user !== EXPECTED_INTEGRATION_USER
      || row.is_superuser !== true
    ) {
      throw new Error(
        "disposable integration reset installer identity mismatch",
      );
    }

    const installed = await client.query(INSTALLATION_CONTRACT_SQL);
    if (installed.rows.length === 0) {
      const alreadyAbsent = await client.query(ABSENCE_CONTRACT_SQL);
      if (
        alreadyAbsent.rows.length !== 1
        || alreadyAbsent.rows[0]?.contract_absent !== true
      ) {
        throw new Error(
          "disposable integration reset teardown precondition failed",
        );
      }
      await client.query("COMMIT");
      return;
    }
    if (
      installed.rows.length !== 1
      || installed.rows[0]?.contract_installed !== true
    ) {
      throw new Error(
        "disposable integration reset teardown precondition failed",
      );
    }

    await client.query(
      "DROP FUNCTION codestead_disposable_test.reset_database()",
    );
    await client.query(
      "DROP SCHEMA codestead_disposable_test RESTRICT",
    );
    const absent = await client.query(ABSENCE_CONTRACT_SQL);
    if (
      absent.rows.length !== 1
      || absent.rows[0]?.contract_absent !== true
    ) {
      throw new Error(
        "disposable integration reset teardown verification failed",
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await rollbackAfterFailure(client, error);
  }
}

export type DisposableIntegrationResetPrimaryState = Readonly<
  | { status: "fulfilled" }
  | { status: "rejected"; reason: unknown }
>;

type DisposableIntegrationResetOutcome<T> = Readonly<
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; reason: unknown }
>;

async function runWithLifecycleClient(
  pool: DisposableIntegrationResetLifecyclePool,
  operation: (
    client: DisposableIntegrationResetInstallerClient,
  ) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  let operationFailure: Readonly<{ error: unknown }> | undefined;
  try {
    await operation(client);
  } catch (error) {
    operationFailure = { error };
  }

  let releaseFailure: Readonly<{ error: unknown }> | undefined;
  try {
    client.release(true);
  } catch (error) {
    releaseFailure = { error };
  }

  if (operationFailure && releaseFailure) {
    throw new AggregateError(
      [operationFailure.error, releaseFailure.error],
      "disposable integration reset lifecycle client failed",
      { cause: operationFailure.error },
    );
  }
  if (operationFailure) throw operationFailure.error;
  if (releaseFailure) throw releaseFailure.error;
}

export async function withDisposableIntegrationReset<T>(
  pool: DisposableIntegrationResetLifecyclePool,
  action: () => Promise<T>,
  beforeTeardown?: (
    primaryState: DisposableIntegrationResetPrimaryState,
  ) => void,
): Promise<T> {
  let installAttempted = false;
  let outcome: DisposableIntegrationResetOutcome<T>;
  try {
    installAttempted = true;
    await runWithLifecycleClient(
      pool,
      installDisposableIntegrationReset,
    );
    outcome = { status: "fulfilled", value: await action() };
  } catch (reason) {
    outcome = { status: "rejected", reason };
  }

  const cleanupFailures: unknown[] = [];
  if (installAttempted) {
    try {
      beforeTeardown?.(
        outcome.status === "fulfilled"
          ? { status: "fulfilled" }
          : { status: "rejected", reason: outcome.reason },
      );
    } catch (error) {
      cleanupFailures.push(error);
    }
    let convergenceRequired = false;
    try {
      await runWithLifecycleClient(
        pool,
        uninstallDisposableIntegrationReset,
      );
    } catch (error) {
      cleanupFailures.push(error);
      convergenceRequired = true;
    }
    if (convergenceRequired) {
      try {
        await runWithLifecycleClient(
          pool,
          uninstallDisposableIntegrationReset,
        );
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
  }

  try {
    await pool.end();
  } catch (error) {
    cleanupFailures.push(error);
  }

  if (outcome.status === "rejected" && cleanupFailures.length > 0) {
    throw new AggregateError(
      [outcome.reason, ...cleanupFailures],
      "disposable integration reset action and teardown failed",
      { cause: outcome.reason },
    );
  }
  if (outcome.status === "rejected") throw outcome.reason;
  if (cleanupFailures.length === 1) throw cleanupFailures[0];
  if (cleanupFailures.length > 1) {
    throw new AggregateError(
      cleanupFailures,
      "disposable integration reset teardown failed",
    );
  }
  return outcome.value;
}
