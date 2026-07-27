-- Forward-only Task 7 component. Journal, reviewed-ledger, role-bootstrap,
-- restore, rollback, and CI registration are integration-owned by Task 8.
DO $lock_successor_receipt$
BEGIN
  IF pg_catalog.to_regclass('public.mail_delivery_release_receipt') IS NOT NULL THEN
    EXECUTE 'LOCK TABLE ONLY public.mail_delivery_release_receipt IN ACCESS EXCLUSIVE MODE NOWAIT';
  END IF;
END
$lock_successor_receipt$;--> statement-breakpoint
LOCK TABLE ONLY public.email_outbox
  IN ACCESS EXCLUSIVE MODE NOWAIT;--> statement-breakpoint
LOCK TABLE ONLY public.email_outbox_idempotency_authority
  IN SHARE MODE NOWAIT;--> statement-breakpoint
LOCK TABLE ONLY public.backup_status_mail_authority
  IN SHARE MODE NOWAIT;--> statement-breakpoint
LOCK TABLE ONLY public."user"
  IN SHARE MODE NOWAIT;--> statement-breakpoint
LOCK TABLE ONLY public.backup_status_mail_admin_guard
  IN SHARE MODE NOWAIT;--> statement-breakpoint
SET LOCAL search_path = pg_catalog, pg_temp;--> statement-breakpoint
SET LOCAL quote_all_identifiers = off;--> statement-breakpoint

DO $preflight$
DECLARE
  successor_relation pg_catalog.regclass :=
    pg_catalog.to_regclass('public.mail_delivery_release_receipt');
  successor_columns pg_catalog.int4;
  successor_routines pg_catalog.int4;
  successor_triggers pg_catalog.int4;
  successor_constraints pg_catalog.int4;
  hold_oid pg_catalog.oid := pg_catalog.to_regprocedure(
    'public.enforce_email_outbox_delivery_hold()'
  )::pg_catalog.oid;
BEGIN
  IF session_user IS DISTINCT FROM 'learncoding_migrator'
     OR current_user IS DISTINCT FROM 'learncoding_owner'
  THEN
    RAISE EXCEPTION '0069 requires the reviewed delegated migration identity'
      USING ERRCODE = '42501';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_roles
     WHERE rolname IN (
       'learncoding_owner',
       'learncoding_migrator',
       'learncoding_app',
       'learncoding_worker',
       'learncoding_ops',
       'learncoding_backup_reporter'
     )
  ) <> 6 THEN
    RAISE EXCEPTION '0069 reviewed database roles are incomplete'
      USING ERRCODE = '42704';
  END IF;

  IF pg_catalog.to_regclass('public.email_outbox') IS NULL
     OR pg_catalog.to_regclass(
          'public.email_outbox_idempotency_authority'
        ) IS NULL
     OR hold_oid IS NULL
     OR pg_catalog.to_regprocedure(
          'public.classify_email_outbox_quarantine_redaction_v2(public.email_outbox,timestamp with time zone)'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'public.enforce_email_outbox_payload_immutable()'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'public.redact_quarantined_email_outbox_authority_v2(timestamp with time zone,integer)'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'public.email_outbox_idempotency_coverage_authority(uuid[])'
        ) IS NULL
  THEN
    RAISE EXCEPTION '0069 reviewed 0068 predecessor is incomplete'
      USING ERRCODE = '23514';
  END IF;

  IF pg_catalog.to_regclass('public.backup_status_mail_admin_guard') IS NULL
     OR pg_catalog.to_regprocedure(
          'public.reject_backup_status_mail_authority_mutation()'
        ) IS NULL
     OR pg_catalog.to_regprocedure(
          'public.lock_backup_status_mail_admin_authority()'
        ) IS NULL
     OR pg_catalog.to_regprocedure('public.backup_status_mail_authorized(uuid)') IS NULL
     OR pg_catalog.to_regclass('public."user"') IS NULL
  THEN
    RAISE EXCEPTION '0069 reviewed backup mail authority is incomplete'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM (VALUES
        (
          'public.email_outbox'::pg_catalog.regclass,
          (
            CASE
              WHEN successor_relation IS NULL THEN 33
              ELSE 37
            END
          )::pg_catalog.int2
        ),
        (
          'public.email_outbox_idempotency_authority'
            ::pg_catalog.regclass,
          2::pg_catalog.int2
        ),
        (
          'public.backup_status_mail_authority'::pg_catalog.regclass,
          7::pg_catalog.int2
        ),
        (
          'public.backup_status_mail_admin_guard'::pg_catalog.regclass,
          2::pg_catalog.int2
        ),
        (successor_relation, 8::pg_catalog.int2)
      ) AS expected(relation_oid, expected_natts)
      LEFT JOIN pg_catalog.pg_class AS relation
        ON relation.oid = expected.relation_oid
     WHERE expected.relation_oid IS NOT NULL
       AND (
         relation.oid IS NULL
        OR relation.relkind <> 'r'
        OR relation.relpersistence <> 'p'
        OR relation.relrowsecurity
        OR relation.relnatts <> expected.expected_natts
        OR relation.reloptions IS NOT NULL
        OR relation.relreplident <> 'd'
        OR relation.relam IS DISTINCT FROM (
          SELECT access_method.oid
            FROM pg_catalog.pg_am AS access_method
           WHERE access_method.amname = 'heap'
             AND access_method.amtype = 't'
        )
        OR relation.relforcerowsecurity
        OR relation.relispartition
        OR relation.relpartbound IS NOT NULL
        OR relation.reloftype <> 0
        OR relation.relhasrules
        OR pg_catalog.pg_get_userbyid(relation.relowner) <>
             'learncoding_owner'
        OR EXISTS (
          SELECT 1
            FROM pg_catalog.pg_attribute AS attribute
           WHERE attribute.attrelid = relation.oid
             AND attribute.attnum > 0
             AND attribute.attisdropped
        )
        OR EXISTS (
          SELECT 1
            FROM pg_catalog.pg_inherits AS inheritance
           WHERE inheritance.inhrelid = relation.oid
              OR inheritance.inhparent = relation.oid
        )
        OR EXISTS (
          SELECT 1
            FROM pg_catalog.pg_partitioned_table AS partitioning
           WHERE partitioning.partrelid = relation.oid
        )
        OR EXISTS (
          SELECT 1
            FROM pg_catalog.pg_policy AS policy
           WHERE policy.polrelid = relation.oid
        )
        OR EXISTS (
          SELECT 1
            FROM pg_catalog.pg_rewrite AS rewrite
           WHERE rewrite.ev_class = relation.oid
        )
       )
  )
     OR EXISTS (
       SELECT 1
         FROM ONLY public.email_outbox AS outbox
        WHERE outbox.delivery_hold_version IS DISTINCT FROM 'task7-v1'
     )
  THEN
    RAISE EXCEPTION '0069 durable replay predecessor relation is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid =
             'public.email_outbox'::pg_catalog.regclass
       AND constraint_row.connamespace = 'public'::pg_catalog.regnamespace
       AND constraint_row.conname = 'email_outbox_delivery_hold_valid'
       AND constraint_row.contype = 'c'
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
       AND constraint_row.conkey = ARRAY[
         (
           SELECT attribute.attnum
             FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid = constraint_row.conrelid
              AND attribute.attname = 'delivery_hold_version'
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
         )
       ]::pg_catalog.int2[]
       AND constraint_row.confkey IS NULL
       AND constraint_row.conpfeqop IS NULL
       AND constraint_row.conppeqop IS NULL
       AND constraint_row.conffeqop IS NULL
       AND constraint_row.confdelsetcols IS NULL
       AND constraint_row.conexclop IS NULL
       AND constraint_row.conbin IS NOT NULL
       AND COALESCE(
             (pg_catalog.to_jsonb(constraint_row)->>'conenforced')
               ::pg_catalog.bool,
             true
           )
       AND NOT COALESCE(
             (pg_catalog.to_jsonb(constraint_row)->>'conperiod')
               ::pg_catalog.bool,
             false
           )
       AND pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(
                 pg_catalog.pg_get_constraintdef(constraint_row.oid, false),
                 'UTF8'
               )
             ),
             'hex'
           ) =
             'c75e00f22207c36e83e3afd99a6553e1be9b50bef41e2caf91f93443a2082d9c'
  )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.email_outbox'::pg_catalog.regclass
          AND attribute.attname = 'status'
          AND attribute.attnum = 8
          AND attribute.atttypid =
                'public.notification_status'::pg_catalog.regtype
          AND attribute.atttypmod = -1
          AND attribute.attnotnull
          AND attribute.atthasdef
          AND attribute.attidentity = ''
          AND attribute.attgenerated = ''
          AND NOT attribute.attisdropped
          AND NOT attribute.atthasmissing
          AND attribute.attmissingval IS NULL
          AND attribute.attislocal
          AND attribute.attinhcount = 0
          AND attribute.attndims = 0
          AND attribute.attoptions IS NULL
          AND attribute.attfdwoptions IS NULL
          AND EXISTS (
            SELECT 1
              FROM pg_catalog.pg_attrdef AS default_row
             WHERE default_row.adrelid = attribute.attrelid
               AND default_row.adnum = attribute.attnum
               AND pg_catalog.pg_get_expr(
                     default_row.adbin,
                     default_row.adrelid,
                     false
                   ) = '''pending''::public.notification_status'
          )
     )
     OR (
       pg_catalog.current_setting('server_version_num')::pg_catalog.int4 >=
         180000
       AND NOT EXISTS (
         SELECT 1
           FROM pg_catalog.pg_constraint AS not_null_constraint
          WHERE not_null_constraint.conrelid =
                  'public.email_outbox'::pg_catalog.regclass
            AND not_null_constraint.contype = 'n'
            AND not_null_constraint.conkey = ARRAY[8]::pg_catalog.int2[]
            AND not_null_constraint.convalidated
            AND not_null_constraint.conislocal
            AND NOT not_null_constraint.connoinherit
            AND not_null_constraint.condeferrable = false
            AND not_null_constraint.condeferred = false
            AND COALESCE(
                  (pg_catalog.to_jsonb(not_null_constraint)->>'conenforced')
                    ::pg_catalog.bool,
                  true
                )
       )
     )
  THEN
    RAISE EXCEPTION '0069 delivery hold/status predecessor is invalid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'email_outbox_delivery_hold_valid';
  END IF;

  IF EXISTS (
    WITH expected_inherited_routines(
      identity,
      routine_name,
      source_sha256,
      definition_sha256,
      ops_execute
    ) AS (
      VALUES
        (
          'public.enforce_email_outbox_dispatch_binding()'::pg_catalog.text,
          'enforce_email_outbox_dispatch_binding'::pg_catalog.text,
          'e03d2be2455d53f9ddd0c0b7a8029efd07186a4d6804b86c2206b29031da7fdf'::pg_catalog.text,
          'b3ba15cae78eaf8e3535b28c0764e9715683e15ab85b0814089e3e54715f4676'::pg_catalog.text,
          false
        ),
        (
          'public.enforce_email_outbox_provider_correlation_evidence()',
          'enforce_email_outbox_provider_correlation_evidence',
          '62ff4885055979fb7eaf0fda3ae8170a14a430cb69d8f310e6aba742cf700e1a',
          'afaab6796f97aa0294ff5a761679895f9ccfb78fea21e0be362979c5c4e5ab11',
          false
        ),
        (
          'public.enforce_email_outbox_idempotency_metadata_immutable()',
          'enforce_email_outbox_idempotency_metadata_immutable',
          '9e953537c1fc8f4cdceda981731aa20c9412dbd46cefdcc71e433de3eced76c3',
          'a26ccda1f7f4d623c7ea2b1611ff9f5c424cee386f79a7a8ffbf2a58c51ce2e9',
          false
        ),
        (
          'public.enforce_email_outbox_idempotency_append_only()',
          'enforce_email_outbox_idempotency_append_only',
          '164b71af1bca387a599b64246851b7ba3e66c8a9557a60581dec54eb4d757370',
          '2ae733ebe79975ce70fa9427ccb92295ecf8acad75797e8541bbb15bd9318790',
          false
        ),
        (
          'public.email_outbox_idempotency_coverage_authority(uuid[])',
          'email_outbox_idempotency_coverage_authority',
          '417c8583bb2509354b89e63317718a14cd0afbf08e62d534cd64341acc290e48',
          '2efbc33e8ee9dd33402f11682697f4e522cd9e7e3c70c8bf820f533b37aec1ac',
          true
        ),
        (
          'public.classify_email_outbox_quarantine_redaction_v2(public.email_outbox,timestamp with time zone)',
          'classify_email_outbox_quarantine_redaction_v2',
          '056ab5e7fdd72b643ba48d9fe6caf0e1c678f4c7e8afbdf8edf0c844e02f0424',
          '8331736656001b0bb0fa5d303667353846ea4ff39c3f5aeba71979141f2dc612',
          false
        ),
        (
          'public.redact_quarantined_email_outbox_authority_v2(timestamp with time zone,integer)',
          'redact_quarantined_email_outbox_authority_v2',
          '5a10a9df1684cb1355941c456eb03e46309eb12fa4dcdcda4ecf5f942241ae7b',
          '29ee2d3b4bf45322c9c68a3bc612084a460bfca3e54e7c2c044081d195fbe2b7',
          true
        ),
        (
          'public.claim_email_outbox_idempotency_authority()',
          'claim_email_outbox_idempotency_authority',
          '9b0b6468cb0aad890bd78ecfa68bdab9f476d5f93a9841d515e0cea019926499',
          'c5e22b06c168cb1aa4099f3b3c66cc959b4a0b116313d2bce8fa3a3d9d77197b',
          false
        ),
        (
          'public.persist_email_outbox_idempotency_authority()',
          'persist_email_outbox_idempotency_authority',
          '43e5df19b455c36648574e1d7c33c10cb959fc3bddd83e6ed67035031f246cbd',
          '4890f478c8d14811e7f6829a3a4977e0da3924c8e8c84b8ca89b64496ac40f53',
          false
        )
    ),
    actual_inherited_routines AS (
      SELECT
        expected.*,
        routine.oid AS routine_oid,
        pg_catalog.pg_get_userbyid(routine.proowner) AS owner_name,
        language.lanname AS language_name,
        routine.prokind,
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
        CASE
          WHEN routine.oid IS NULL THEN NULL
          ELSE COALESCE(
            (
              SELECT pg_catalog.array_agg(
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
                         access.is_grantable
                       )
                       ORDER BY pg_catalog.concat_ws(
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
                         access.is_grantable
                       )
                     )
                FROM pg_catalog.aclexplode(
                       COALESCE(
                         routine.proacl,
                         pg_catalog.acldefault('f', routine.proowner)
                       )
                     ) AS access
            ),
            ARRAY[]::pg_catalog.text[]
          )
        END AS execute_acl,
        (
          SELECT pg_catalog.count(*)
            FROM pg_catalog.pg_proc AS overload
           WHERE overload.pronamespace = 'public'::pg_catalog.regnamespace
             AND overload.proname = expected.routine_name
        ) AS overload_count
        FROM expected_inherited_routines AS expected
        LEFT JOIN pg_catalog.pg_proc AS routine
          ON routine.oid = pg_catalog.to_regprocedure(expected.identity)
        LEFT JOIN pg_catalog.pg_language AS language
          ON language.oid = routine.prolang
    )
    SELECT 1
      FROM actual_inherited_routines AS actual
     WHERE actual.routine_oid IS NULL
        OR actual.owner_name IS DISTINCT FROM 'learncoding_owner'
        OR actual.language_name IS DISTINCT FROM 'plpgsql'
        OR actual.prokind IS DISTINCT FROM 'f'
        OR actual.actual_source_sha256 IS DISTINCT FROM actual.source_sha256
        OR actual.actual_definition_sha256 IS DISTINCT FROM
             actual.definition_sha256
        OR actual.overload_count <> 1
        OR actual.execute_acl IS DISTINCT FROM CASE
          WHEN actual.ops_execute THEN ARRAY[
            'learncoding_ops|learncoding_owner|execute|f',
            'learncoding_owner|learncoding_owner|execute|f'
          ]::pg_catalog.text[]
          ELSE ARRAY[
            'learncoding_owner|learncoding_owner|execute|f'
          ]::pg_catalog.text[]
        END
  )
  THEN
    RAISE EXCEPTION '0069 inherited mail authority routines are invalid'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    WITH expected_digest_helpers(
      identity,
      routine_name,
      source_sha256,
      definition_sha256
    ) AS (
      VALUES
        (
          'public.email_outbox_original_payload_sha256(text,text,text,text,jsonb)'::pg_catalog.text,
          'email_outbox_original_payload_sha256'::pg_catalog.text,
          '6b7100af8bd25093520317e67d5a06b40848b192ca94eb4b6c63ef48adcf89a2'::pg_catalog.text,
          CASE
            pg_catalog.current_setting('server_version_num')::pg_catalog.int4
              / 10000
            WHEN 17 THEN
              '35691db9ef3153adf2e19ebae539341797f7b4fd2a27aec1db215b9533636ed8'
            WHEN 18 THEN
              '365bd47aab3ce58ca2b894c7eb77ed12cb759fc3683599ef5ae987e4414f1d3c'
            ELSE NULL
          END
        ),
        (
          'public.email_outbox_event_sha256(text,text,text)',
          'email_outbox_event_sha256',
          'dbb1e105e567de47875c1bdd433b61cc78745fc0bc7953daa68b6f3f2bf83315',
          '02d83d883c8f4c0b4fc22c460353834d27a67becdd96d81cee8b74609521f334'
        )
    ),
    actual_digest_helpers AS (
      SELECT
        expected.*,
        routine.oid AS routine_oid,
        pg_catalog.pg_get_userbyid(routine.proowner) AS owner_name,
        language.lanname AS language_name,
        routine.prokind,
        routine.prorettype,
        routine.proretset,
        routine.provolatile,
        routine.prosecdef,
        routine.proleakproof,
        routine.proisstrict,
        routine.proparallel,
        routine.proconfig,
        routine.pronargdefaults,
        routine.proargdefaults,
        routine.proallargtypes,
        routine.proargmodes,
        routine.protrftypes,
        routine.provariadic,
        routine.prosupport,
        routine.procost,
        routine.prorows,
        routine.probin,
        routine.prosqlbody,
        routine.proacl,
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
        (
          SELECT pg_catalog.count(*)
            FROM pg_catalog.pg_proc AS overload
           WHERE overload.pronamespace = 'public'::pg_catalog.regnamespace
             AND overload.proname = expected.routine_name
        ) AS overload_count
        FROM expected_digest_helpers AS expected
        LEFT JOIN pg_catalog.pg_proc AS routine
          ON routine.oid = pg_catalog.to_regprocedure(expected.identity)
        LEFT JOIN pg_catalog.pg_language AS language
          ON language.oid = routine.prolang
    )
    SELECT 1
      FROM actual_digest_helpers AS actual
     WHERE actual.routine_oid IS NULL
        OR actual.owner_name IS DISTINCT FROM 'learncoding_owner'
        OR actual.language_name IS DISTINCT FROM 'sql'
        OR actual.prokind IS DISTINCT FROM 'f'
        OR actual.prorettype IS DISTINCT FROM
             'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid
        OR actual.proretset
        OR actual.provolatile IS DISTINCT FROM 'i'
        OR NOT actual.prosecdef
        OR actual.proleakproof
        OR actual.proisstrict
        OR actual.proparallel IS DISTINCT FROM 'u'
        OR actual.proconfig IS DISTINCT FROM
             ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
        OR actual.pronargdefaults <> 0
        OR actual.proargdefaults IS NOT NULL
        OR actual.proallargtypes IS NOT NULL
        OR actual.proargmodes IS NOT NULL
        OR actual.protrftypes IS NOT NULL
        OR actual.provariadic <> 0
        OR actual.prosupport <> 0
        OR actual.procost <> 100
        OR actual.prorows <> 0
        OR actual.probin IS NOT NULL
        OR actual.prosqlbody IS NOT NULL
        OR actual.proacl IS DISTINCT FROM ARRAY[
             'learncoding_owner=X/learncoding_owner'::pg_catalog.aclitem
           ]::pg_catalog.aclitem[]
        OR actual.actual_source_sha256 IS DISTINCT FROM actual.source_sha256
        OR actual.actual_definition_sha256 IS DISTINCT FROM
             actual.definition_sha256
        OR actual.overload_count <> 1
  )
  THEN
    RAISE EXCEPTION '0069 inherited mail digest helpers are invalid'
      USING ERRCODE = '42501';
  END IF;
  IF (
    SELECT pg_catalog.count(*)
      FROM (VALUES
        (
          'public.claim_email_outbox_idempotency_authority()'::pg_catalog.text,
          '9b0b6468cb0aad890bd78ecfa68bdab9f476d5f93a9841d515e0cea019926499'::pg_catalog.text,
          'c5e22b06c168cb1aa4099f3b3c66cc959b4a0b116313d2bce8fa3a3d9d77197b'::pg_catalog.text
        ),
        (
          'public.persist_email_outbox_idempotency_authority()',
          '43e5df19b455c36648574e1d7c33c10cb959fc3bddd83e6ed67035031f246cbd',
          '4890f478c8d14811e7f6829a3a4977e0da3924c8e8c84b8ca89b64496ac40f53'
        )
      ) AS expected(identity, source_sha256, definition_sha256)
      JOIN pg_catalog.pg_proc AS routine
        ON routine.oid = pg_catalog.to_regprocedure(expected.identity)
      JOIN pg_catalog.pg_language AS language
        ON language.oid = routine.prolang
     WHERE pg_catalog.pg_get_userbyid(routine.proowner) =
             'learncoding_owner'
       AND language.lanname = 'plpgsql'
       AND routine.prokind = 'f'
       AND routine.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
       AND NOT routine.proretset
       AND routine.provolatile = 'v'
       AND routine.prosecdef
       AND NOT routine.proisstrict
       AND routine.proparallel = 'u'
       AND routine.proconfig =
             ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
       AND routine.pronargs = 0
       AND routine.pronargdefaults = 0
       AND routine.proargnames IS NULL
       AND routine.proallargtypes IS NULL
       AND routine.proargmodes IS NULL
       AND routine.proargdefaults IS NULL
       AND routine.protrftypes IS NULL
       AND routine.provariadic = 0
       AND NOT routine.proleakproof
       AND routine.prosupport = 0
       AND routine.procost = 100
       AND routine.prorows = 0
       AND routine.probin IS NULL
       AND routine.prosqlbody IS NULL
       AND routine.proacl IS NOT DISTINCT FROM ARRAY[
             'learncoding_owner=X/learncoding_owner'::pg_catalog.aclitem
           ]::pg_catalog.aclitem[]
       AND pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(routine.prosrc, 'UTF8')
             ),
             'hex'
           ) = expected.source_sha256
       AND pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(
                 pg_catalog.pg_get_functiondef(routine.oid),
                 'UTF8'
               )
             ),
             'hex'
           ) = expected.definition_sha256
  ) <> 2
     OR (
       SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_proc AS routine
        WHERE routine.pronamespace = 'public'::pg_catalog.regnamespace
          AND routine.proname IN (
            'claim_email_outbox_idempotency_authority',
            'persist_email_outbox_idempotency_authority'
          )
     ) <> 2
  THEN
    RAISE EXCEPTION '0069 exact Task 5 replay routines are invalid'
      USING ERRCODE = '42501';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
      FROM (VALUES
        (
          'email_outbox_idempotency_claim'::pg_catalog.text,
          'public.claim_email_outbox_idempotency_authority()'::pg_catalog.text,
          7::pg_catalog.int2
        ),
        (
          '00_email_outbox_idempotency_persist',
          'public.persist_email_outbox_idempotency_authority()',
          5::pg_catalog.int2
        )
      ) AS expected(trigger_name, function_identity, trigger_type)
      JOIN pg_catalog.pg_trigger AS trigger_row
        ON trigger_row.tgrelid = 'public.email_outbox'::pg_catalog.regclass
       AND trigger_row.tgname = expected.trigger_name
     WHERE NOT trigger_row.tgisinternal
       AND trigger_row.tgconstraint = 0
       AND trigger_row.tgconstrrelid = 0
       AND trigger_row.tgconstrindid = 0
       AND trigger_row.tgparentid = 0
       AND NOT trigger_row.tgdeferrable
       AND NOT trigger_row.tginitdeferred
       AND trigger_row.tgqual IS NULL
       AND trigger_row.tgoldtable IS NULL
       AND trigger_row.tgnewtable IS NULL
       AND trigger_row.tgtype = expected.trigger_type
       AND trigger_row.tgenabled = 'A'
       AND trigger_row.tgnargs = 0
       AND pg_catalog.octet_length(trigger_row.tgargs) = 0
       AND pg_catalog.cardinality(
             trigger_row.tgattr::pg_catalog.int2[]
           ) = 0
       AND trigger_row.tgfoid =
             pg_catalog.to_regprocedure(expected.function_identity)
  ) <> 2
     OR (
       SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_trigger AS trigger_row
        WHERE trigger_row.tgfoid IN (
          pg_catalog.to_regprocedure(
            'public.claim_email_outbox_idempotency_authority()'
          ),
          pg_catalog.to_regprocedure(
            'public.persist_email_outbox_idempotency_authority()'
          )
        )
     ) <> 2
  THEN
    RAISE EXCEPTION '0069 exact Task 5 replay triggers are invalid'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
     WHERE trigger_row.tgrelid =
             'public.email_outbox'::pg_catalog.regclass
       AND trigger_row.tgname = 'email_outbox_payload_immutable'
       AND NOT trigger_row.tgisinternal
       AND trigger_row.tgconstraint = 0
       AND trigger_row.tgconstrrelid = 0
       AND trigger_row.tgqual IS NULL
       AND trigger_row.tgtype = 19
       AND trigger_row.tgenabled = 'A'
       AND trigger_row.tgnargs = 0
       AND pg_catalog.octet_length(trigger_row.tgargs) = 0
       AND trigger_row.tgfoid = pg_catalog.to_regprocedure(
             'public.enforce_email_outbox_payload_immutable()'
           )
  ) THEN
    RAISE EXCEPTION '0069 0068 payload trigger predecessor is invalid'
      USING ERRCODE = '42501';
  END IF;

  IF pg_catalog.to_regprocedure(
       'public.redact_unresolved_email_outbox_authority(timestamp with time zone,integer)'
     ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'public.classify_email_outbox_retention_redaction(public.email_outbox,timestamp with time zone)'
     ) IS NOT NULL
  THEN
    RAISE EXCEPTION '0069 retired redaction authority unexpectedly exists'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    WITH expected_backup_columns(
      relation_oid,
      attribute_number,
      column_name,
      type_oid,
      is_not_null,
      default_expression,
      exact_shape
    ) AS (
      VALUES
        ('public.backup_status_mail_authority'::pg_catalog.regclass,
         1::pg_catalog.int2, 'id'::pg_catalog.text,
         'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,
         true, NULL::pg_catalog.text, true),
        ('public.backup_status_mail_authority'::pg_catalog.regclass,
         2::pg_catalog.int2, 'run_key'::pg_catalog.text,
         'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
         true, NULL::pg_catalog.text, true),
        ('public.backup_status_mail_authority'::pg_catalog.regclass,
         3::pg_catalog.int2, 'outcome'::pg_catalog.text,
         'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
         true, NULL::pg_catalog.text, true),
        ('public.backup_status_mail_authority'::pg_catalog.regclass,
         4::pg_catalog.int2, 'outbox_id'::pg_catalog.text,
         'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,
         true, NULL::pg_catalog.text, true),
        ('public.backup_status_mail_authority'::pg_catalog.regclass,
         5::pg_catalog.int2, 'operation_id'::pg_catalog.text,
         'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,
         true, NULL::pg_catalog.text, true),
        ('public.backup_status_mail_authority'::pg_catalog.regclass,
         6::pg_catalog.int2, 'authority_epoch'::pg_catalog.text,
         'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,
         true, NULL::pg_catalog.text, true),
        ('public.backup_status_mail_authority'::pg_catalog.regclass,
         7::pg_catalog.int2, 'created_at'::pg_catalog.text,
         'pg_catalog.timestamptz'::pg_catalog.regtype::pg_catalog.oid,
         true, 'statement_timestamp()'::pg_catalog.text, true),
        ('public.backup_status_mail_admin_guard'::pg_catalog.regclass,
         1::pg_catalog.int2, 'singleton'::pg_catalog.text,
         'pg_catalog.bool'::pg_catalog.regtype::pg_catalog.oid,
         true, 'true'::pg_catalog.text, true),
        ('public.backup_status_mail_admin_guard'::pg_catalog.regclass,
         2::pg_catalog.int2, 'authority_epoch'::pg_catalog.text,
         'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,
         true, 'gen_random_uuid()'::pg_catalog.text, true)
    ),
    actual_backup_columns AS (
      SELECT
        attribute.attrelid AS relation_oid,
        attribute.attnum AS attribute_number,
        attribute.attname::pg_catalog.text AS column_name,
        attribute.atttypid AS type_oid,
        attribute.attnotnull AS is_not_null,
        default_row.default_expression,
        (
          attribute.atttypmod = -1
          AND attribute.attcollation = type_row.typcollation
          AND attribute.attlen = type_row.typlen
          AND attribute.attbyval = type_row.typbyval
          AND attribute.attalign = type_row.typalign
          AND attribute.attstorage = type_row.typstorage
          AND attribute.attcompression = ''::"char"
          AND attribute.attstattarget IS NULL
          AND attribute.attndims = 0
          AND attribute.attidentity = ''
          AND attribute.attgenerated = ''
          AND attribute.atthasdef = (default_row.default_expression IS NOT NULL)
          AND NOT attribute.atthasmissing
          AND attribute.attmissingval IS NULL
          AND attribute.attislocal
          AND attribute.attinhcount = 0
          AND attribute.attoptions IS NULL
          AND attribute.attfdwoptions IS NULL
        ) AS exact_shape
        FROM pg_catalog.pg_attribute AS attribute
        JOIN pg_catalog.pg_type AS type_row
          ON type_row.oid = attribute.atttypid
        LEFT JOIN LATERAL (
          SELECT pg_catalog.pg_get_expr(
                   definition.adbin,
                   definition.adrelid,
                   false
                 ) AS default_expression
            FROM pg_catalog.pg_attrdef AS definition
           WHERE definition.adrelid = attribute.attrelid
             AND definition.adnum = attribute.attnum
        ) AS default_row ON true
       WHERE attribute.attrelid IN (
         'public.backup_status_mail_authority'::pg_catalog.regclass,
         'public.backup_status_mail_admin_guard'::pg_catalog.regclass
       )
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
    ),
    backup_column_delta AS (
      SELECT * FROM (
        SELECT * FROM expected_backup_columns
        EXCEPT ALL
        SELECT * FROM actual_backup_columns
      ) AS missing_backup_columns
      UNION ALL
      SELECT * FROM (
        SELECT * FROM actual_backup_columns
        EXCEPT ALL
        SELECT * FROM expected_backup_columns
      ) AS unexpected_backup_columns
    )
    SELECT 1 FROM backup_column_delta
  )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid IN (
          'public.backup_status_mail_authority'::pg_catalog.regclass,
          'public.backup_status_mail_admin_guard'::pg_catalog.regclass
        )
          AND attribute.attnum > 0
          AND attribute.attisdropped
     )
     OR (
       SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_attrdef AS definition
        WHERE definition.adrelid IN (
          'public.backup_status_mail_authority'::pg_catalog.regclass,
          'public.backup_status_mail_admin_guard'::pg_catalog.regclass
        )
     ) <> 3
  THEN
    RAISE EXCEPTION '0069 exact Task 5 backup columns are invalid'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    WITH expected_backup_constraints(
      relation_oid,
      constraint_name,
      constraint_type,
      key_columns,
      definition,
      exact_shape
    ) AS (
      VALUES
        ('public.backup_status_mail_authority'::pg_catalog.regclass,
         'backup_status_mail_authority_epoch_valid'::pg_catalog.text,
         'c'::"char", ARRAY[6]::pg_catalog.int2[],
         'CHECK ((authority_epoch <> ''00000000-0000-0000-0000-000000000000''::uuid))'::pg_catalog.text,
         true),
        ('public.backup_status_mail_authority'::pg_catalog.regclass,
         'backup_status_mail_authority_operation_id_key',
         'u'::"char", ARRAY[5]::pg_catalog.int2[],
         'UNIQUE (operation_id)', true),
        ('public.backup_status_mail_authority'::pg_catalog.regclass,
         'backup_status_mail_authority_outbox_id_key',
         'u'::"char", ARRAY[4]::pg_catalog.int2[],
         'UNIQUE (outbox_id)', true),
        ('public.backup_status_mail_authority'::pg_catalog.regclass,
         'backup_status_mail_authority_outcome_valid',
         'c'::"char", ARRAY[3]::pg_catalog.int2[],
         'CHECK ((outcome = ANY (ARRAY[''success''::text, ''failure''::text])))',
         true),
        ('public.backup_status_mail_authority'::pg_catalog.regclass,
         'backup_status_mail_authority_pkey',
         'p'::"char", ARRAY[1]::pg_catalog.int2[],
         'PRIMARY KEY (id)', true),
        ('public.backup_status_mail_authority'::pg_catalog.regclass,
         'backup_status_mail_authority_run_key_key',
         'u'::"char", ARRAY[2]::pg_catalog.int2[],
         'UNIQUE (run_key)', true),
        ('public.backup_status_mail_authority'::pg_catalog.regclass,
         'backup_status_mail_authority_run_key_valid',
         'c'::"char", ARRAY[2]::pg_catalog.int2[],
         'CHECK (((run_key ~ ''^[0-9]{8}T[0-9]{6}Z$''::text) OR (run_key ~ ''^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$''::text)))',
         true),
        ('public.backup_status_mail_admin_guard'::pg_catalog.regclass,
         'backup_status_mail_admin_guard_epoch_valid',
         'c'::"char", ARRAY[2]::pg_catalog.int2[],
         'CHECK ((authority_epoch <> ''00000000-0000-0000-0000-000000000000''::uuid))',
         true),
        ('public.backup_status_mail_admin_guard'::pg_catalog.regclass,
         'backup_status_mail_admin_guard_pkey',
         'p'::"char", ARRAY[1]::pg_catalog.int2[],
         'PRIMARY KEY (singleton)', true),
        ('public.backup_status_mail_admin_guard'::pg_catalog.regclass,
         'backup_status_mail_admin_guard_singleton',
         'c'::"char", ARRAY[1]::pg_catalog.int2[],
         'CHECK ((singleton IS TRUE))', true)
    ),
    actual_backup_constraints AS (
      SELECT
        constraint_row.conrelid AS relation_oid,
        constraint_row.conname::pg_catalog.text AS constraint_name,
        constraint_row.contype AS constraint_type,
        constraint_row.conkey,
        pg_catalog.pg_get_constraintdef(constraint_row.oid, false)
          AS definition,
        (
          constraint_row.connamespace = 'public'::pg_catalog.regnamespace
          AND constraint_row.convalidated
          AND constraint_row.conislocal
          AND constraint_row.coninhcount = 0
          AND constraint_row.conparentid = 0
          AND constraint_row.connoinherit =
                (constraint_row.contype IN ('p', 'u'))
          AND NOT constraint_row.condeferrable
          AND NOT constraint_row.condeferred
          AND constraint_row.contypid = 0
          AND constraint_row.confrelid = 0
          AND constraint_row.confkey IS NULL
          AND constraint_row.confdelsetcols IS NULL
          AND constraint_row.conexclop IS NULL
          AND COALESCE(
                (pg_catalog.to_jsonb(constraint_row)->>'conenforced')
                  ::pg_catalog.bool,
                true
              )
          AND NOT COALESCE(
                (pg_catalog.to_jsonb(constraint_row)->>'conperiod')
                  ::pg_catalog.bool,
                false
              )
          AND (
            (constraint_row.contype = 'c'
             AND constraint_row.conindid = 0
             AND constraint_row.conbin IS NOT NULL)
            OR
            (constraint_row.contype IN ('p', 'u')
             AND constraint_row.conindid =
                   pg_catalog.to_regclass(
                     'public.' || pg_catalog.quote_ident(constraint_row.conname)
                   )
             AND constraint_row.conbin IS NULL)
          )
        ) AS exact_shape
        FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid IN (
         'public.backup_status_mail_authority'::pg_catalog.regclass,
         'public.backup_status_mail_admin_guard'::pg_catalog.regclass
       )
         AND NOT (
           pg_catalog.current_setting('server_version_num')::pg_catalog.int4 >=
             180000
           AND constraint_row.contype = 'n'
         )
    ),
    backup_constraint_delta AS (
      SELECT * FROM (
        SELECT * FROM expected_backup_constraints
        EXCEPT ALL
        SELECT * FROM actual_backup_constraints
      ) AS missing_backup_constraints
      UNION ALL
      SELECT * FROM (
        SELECT * FROM actual_backup_constraints
        EXCEPT ALL
        SELECT * FROM expected_backup_constraints
      ) AS unexpected_backup_constraints
    )
    SELECT 1 FROM backup_constraint_delta
  )
  THEN
    RAISE EXCEPTION '0069 exact Task 5 backup constraints are invalid'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    WITH expected_backup_indexes(
      relation_oid,
      index_name,
      key_columns,
      is_primary,
      definition,
      exact_shape
    ) AS (
      VALUES
        ('public.backup_status_mail_authority'::pg_catalog.regclass,
         'backup_status_mail_authority_operation_id_key'::pg_catalog.text,
         ARRAY[5]::pg_catalog.int2[], false,
         'CREATE UNIQUE INDEX backup_status_mail_authority_operation_id_key ON public.backup_status_mail_authority USING btree (operation_id)'::pg_catalog.text,
         true),
        ('public.backup_status_mail_authority'::pg_catalog.regclass,
         'backup_status_mail_authority_outbox_id_key',
         ARRAY[4]::pg_catalog.int2[], false,
         'CREATE UNIQUE INDEX backup_status_mail_authority_outbox_id_key ON public.backup_status_mail_authority USING btree (outbox_id)',
         true),
        ('public.backup_status_mail_authority'::pg_catalog.regclass,
         'backup_status_mail_authority_pkey',
         ARRAY[1]::pg_catalog.int2[], true,
         'CREATE UNIQUE INDEX backup_status_mail_authority_pkey ON public.backup_status_mail_authority USING btree (id)',
         true),
        ('public.backup_status_mail_authority'::pg_catalog.regclass,
         'backup_status_mail_authority_run_key_key',
         ARRAY[2]::pg_catalog.int2[], false,
         'CREATE UNIQUE INDEX backup_status_mail_authority_run_key_key ON public.backup_status_mail_authority USING btree (run_key)',
         true),
        ('public.backup_status_mail_admin_guard'::pg_catalog.regclass,
         'backup_status_mail_admin_guard_pkey',
         ARRAY[1]::pg_catalog.int2[], true,
         'CREATE UNIQUE INDEX backup_status_mail_admin_guard_pkey ON public.backup_status_mail_admin_guard USING btree (singleton)',
         true)
    ),
    actual_backup_indexes AS (
      SELECT
        index_row.indrelid AS relation_oid,
        index_relation.relname::pg_catalog.text AS index_name,
        ARRAY(
          SELECT key_column.attnum
            FROM pg_catalog.unnest(
                   index_row.indkey::pg_catalog.int2[]
                 ) WITH ORDINALITY AS key_column(attnum, ordinality)
           ORDER BY key_column.ordinality
        )::pg_catalog.int2[] AS key_columns,
        index_row.indisprimary AS is_primary,
        pg_catalog.pg_get_indexdef(index_row.indexrelid) AS definition,
        (
          index_relation.relkind = 'i'
          AND index_relation.relpersistence = 'p'
          AND pg_catalog.pg_get_userbyid(index_relation.relowner) =
                'learncoding_owner'
          AND index_relation.reloptions IS NULL
          AND index_relation.reltablespace = 0
          AND access_method.amname = 'btree'
          AND index_row.indisunique
          AND NOT index_row.indisexclusion
          AND index_row.indimmediate
          AND index_row.indisvalid
          AND index_row.indisready
          AND index_row.indislive
          AND NOT index_row.indisclustered
          AND NOT index_row.indisreplident
          AND NOT index_row.indcheckxmin
          AND NOT index_row.indnullsnotdistinct
          AND index_row.indnkeyatts = 1
          AND index_row.indnatts = 1
          AND index_row.indexprs IS NULL
          AND index_row.indpred IS NULL
          AND NOT EXISTS (
            SELECT 1
              FROM ROWS FROM (
                     pg_catalog.unnest(index_row.indkey::pg_catalog.int2[]),
                     pg_catalog.unnest(index_row.indclass::pg_catalog.oid[]),
                     pg_catalog.unnest(index_row.indcollation::pg_catalog.oid[]),
                     pg_catalog.unnest(index_row.indoption::pg_catalog.int2[])
                   ) AS key_column(
                     attnum, opclass_oid, collation_oid, option_bits
                   )
              JOIN pg_catalog.pg_attribute AS attribute
                ON attribute.attrelid = index_row.indrelid
               AND attribute.attnum = key_column.attnum
             WHERE key_column.attnum <= 0
                OR key_column.option_bits <> 0
                OR key_column.collation_oid <> attribute.attcollation
                OR NOT EXISTS (
                  SELECT 1
                    FROM pg_catalog.pg_opclass AS opclass
                   WHERE opclass.oid = key_column.opclass_oid
                     AND opclass.opcmethod = index_relation.relam
                     AND opclass.opcintype = attribute.atttypid
                     AND opclass.opcdefault
                )
          )
        ) AS exact_shape
        FROM pg_catalog.pg_index AS index_row
        JOIN pg_catalog.pg_class AS index_relation
          ON index_relation.oid = index_row.indexrelid
        JOIN pg_catalog.pg_am AS access_method
          ON access_method.oid = index_relation.relam
       WHERE index_row.indrelid IN (
         'public.backup_status_mail_authority'::pg_catalog.regclass,
         'public.backup_status_mail_admin_guard'::pg_catalog.regclass
       )
    ),
    backup_index_delta AS (
      SELECT * FROM (
        SELECT * FROM expected_backup_indexes
        EXCEPT ALL
        SELECT * FROM actual_backup_indexes
      ) AS missing_backup_indexes
      UNION ALL
      SELECT * FROM (
        SELECT * FROM actual_backup_indexes
        EXCEPT ALL
        SELECT * FROM expected_backup_indexes
      ) AS unexpected_backup_indexes
    )
    SELECT 1 FROM backup_index_delta
  )
  THEN
    RAISE EXCEPTION '0069 exact Task 5 backup indexes are invalid'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    WITH expected_backup_triggers(
      relation_oid,
      trigger_name,
      function_oid,
      trigger_type,
      enabled_mode,
      watched_columns,
      exact_shape
    ) AS (
      VALUES
        ('public.backup_status_mail_authority'::pg_catalog.regclass,
         'backup_status_mail_authority_immutable'::pg_catalog.text,
         pg_catalog.to_regprocedure(
           'public.reject_backup_status_mail_authority_mutation()'
         )::pg_catalog.oid,
         27::pg_catalog.int2, 'O'::"char", ARRAY[]::pg_catalog.int2[], true),
        ('public.backup_status_mail_authority'::pg_catalog.regclass,
         'backup_status_mail_authority_no_truncate',
         pg_catalog.to_regprocedure(
           'public.reject_backup_status_mail_authority_mutation()'
         )::pg_catalog.oid,
         34::pg_catalog.int2, 'O'::"char", ARRAY[]::pg_catalog.int2[], true),
        ('public.user'::pg_catalog.regclass,
         'backup_status_mail_admin_insert_lock',
         pg_catalog.to_regprocedure(
           'public.lock_backup_status_mail_admin_authority()'
         )::pg_catalog.oid,
         7::pg_catalog.int2, 'O'::"char", ARRAY[]::pg_catalog.int2[], true),
        ('public.user'::pg_catalog.regclass,
         'backup_status_mail_admin_update_lock',
         pg_catalog.to_regprocedure(
           'public.lock_backup_status_mail_admin_authority()'
         )::pg_catalog.oid,
         19::pg_catalog.int2, 'O'::"char",
         ARRAY[
           (SELECT attribute.attnum FROM pg_catalog.pg_attribute AS attribute
             WHERE attribute.attrelid = 'public.user'::pg_catalog.regclass
               AND attribute.attname = 'id' AND NOT attribute.attisdropped),
           (SELECT attribute.attnum FROM pg_catalog.pg_attribute AS attribute
             WHERE attribute.attrelid = 'public.user'::pg_catalog.regclass
               AND attribute.attname = 'email' AND NOT attribute.attisdropped),
           (SELECT attribute.attnum FROM pg_catalog.pg_attribute AS attribute
             WHERE attribute.attrelid = 'public.user'::pg_catalog.regclass
               AND attribute.attname = 'role' AND NOT attribute.attisdropped),
           (SELECT attribute.attnum FROM pg_catalog.pg_attribute AS attribute
             WHERE attribute.attrelid = 'public.user'::pg_catalog.regclass
               AND attribute.attname = 'status' AND NOT attribute.attisdropped),
           (SELECT attribute.attnum FROM pg_catalog.pg_attribute AS attribute
             WHERE attribute.attrelid = 'public.user'::pg_catalog.regclass
               AND attribute.attname = 'banned' AND NOT attribute.attisdropped)
         ]::pg_catalog.int2[], true),
        ('public.user'::pg_catalog.regclass,
         'backup_status_mail_admin_delete_lock',
         pg_catalog.to_regprocedure(
           'public.lock_backup_status_mail_admin_authority()'
         )::pg_catalog.oid,
         11::pg_catalog.int2, 'O'::"char", ARRAY[]::pg_catalog.int2[], true)
    ),
    actual_backup_triggers AS (
      SELECT
        trigger_row.tgrelid AS relation_oid,
        trigger_row.tgname::pg_catalog.text AS trigger_name,
        trigger_row.tgfoid AS function_oid,
        trigger_row.tgtype AS trigger_type,
        trigger_row.tgenabled AS enabled_mode,
        ARRAY(
          SELECT watched.attnum
            FROM pg_catalog.unnest(
                   trigger_row.tgattr::pg_catalog.int2[]
                 ) WITH ORDINALITY AS watched(attnum, ordinality)
           ORDER BY watched.ordinality
        )::pg_catalog.int2[] AS watched_columns,
        (
          NOT trigger_row.tgisinternal
          AND trigger_row.tgconstraint = 0
          AND trigger_row.tgconstrrelid = 0
          AND trigger_row.tgconstrindid = 0
          AND trigger_row.tgparentid = 0
          AND NOT trigger_row.tgdeferrable
          AND NOT trigger_row.tginitdeferred
          AND trigger_row.tgqual IS NULL
          AND trigger_row.tgoldtable IS NULL
          AND trigger_row.tgnewtable IS NULL
          AND trigger_row.tgnargs = 0
          AND pg_catalog.octet_length(trigger_row.tgargs) = 0
        ) AS exact_shape
        FROM pg_catalog.pg_trigger AS trigger_row
       WHERE NOT trigger_row.tgisinternal
         AND (
           trigger_row.tgrelid IN (
             'public.backup_status_mail_authority'::pg_catalog.regclass,
             'public.backup_status_mail_admin_guard'::pg_catalog.regclass
           )
           OR (
             trigger_row.tgrelid = 'public.user'::pg_catalog.regclass
             AND (
               trigger_row.tgname LIKE 'backup_status_mail_admin_%'
               OR trigger_row.tgfoid = pg_catalog.to_regprocedure(
                 'public.lock_backup_status_mail_admin_authority()'
               )
             )
           )
         )
    ),
    backup_trigger_delta AS (
      SELECT * FROM (
        SELECT * FROM expected_backup_triggers
        EXCEPT ALL
        SELECT * FROM actual_backup_triggers
      ) AS missing_backup_triggers
      UNION ALL
      SELECT * FROM (
        SELECT * FROM actual_backup_triggers
        EXCEPT ALL
        SELECT * FROM expected_backup_triggers
      ) AS unexpected_backup_triggers
    )
    SELECT 1 FROM backup_trigger_delta
  )
     OR (
       SELECT pg_catalog.count(*)
         FROM ONLY public.backup_status_mail_admin_guard
     ) <> 1
     OR NOT EXISTS (
       SELECT 1
         FROM ONLY public.backup_status_mail_admin_guard AS authority_guard
        WHERE authority_guard.singleton IS TRUE
          AND authority_guard.authority_epoch IS NOT NULL
          AND authority_guard.authority_epoch <>
                '00000000-0000-0000-0000-000000000000'::pg_catalog.uuid
     )
  THEN
    RAISE EXCEPTION '0069 exact Task 5 backup triggers or guard state are invalid'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    WITH expected_backup_routines(
      identity,
      routine_name,
      security_definer,
      settings,
      input_types,
      argument_names,
      all_argument_types,
      argument_modes,
      return_type,
      returns_set,
      expected_rows,
      source_sha256,
      definition_sha256,
      execute_acl
    ) AS (
      VALUES
        (
          'public.reject_backup_status_mail_authority_mutation()'::pg_catalog.text,
          'reject_backup_status_mail_authority_mutation'::pg_catalog.text,
          false,
          ARRAY['search_path=pg_catalog']::pg_catalog.text[],
          ARRAY[]::pg_catalog.oid[],
          NULL::pg_catalog.text[],
          NULL::pg_catalog.oid[],
          NULL::pg_catalog.text[],
          'pg_catalog.trigger'::pg_catalog.regtype,
          false,
          0::pg_catalog.float4,
          '821807d9e78e8d31b0c6ebb567a51c92f04830848de2d555e4f8be8fd370c0db'::pg_catalog.text,
          '30414dca0ae964f5275372bc0c8f1607417c0fa5d22786977b25c21be877d240'::pg_catalog.text,
          ARRAY[
            'learncoding_owner|learncoding_owner|execute|f'
          ]::pg_catalog.text[]
        ),
        (
          'public.lock_backup_status_mail_admin_authority()',
          'lock_backup_status_mail_admin_authority',
          true,
          ARRAY['search_path=pg_catalog']::pg_catalog.text[],
          ARRAY[]::pg_catalog.oid[],
          NULL::pg_catalog.text[],
          NULL::pg_catalog.oid[],
          NULL::pg_catalog.text[],
          'pg_catalog.trigger'::pg_catalog.regtype,
          false,
          0::pg_catalog.float4,
          '3c9e8f9ba6e0095a3f6868150677cf450942d9ffc91d0a34b7c2a65d044ccb1f',
          '58188d5627aed8c443f506e3cda54ac171c2f8219bad481f26a832ace66df3bc',
          ARRAY[
            'learncoding_owner|learncoding_owner|execute|f'
          ]::pg_catalog.text[]
        ),
        (
          'public.enqueue_backup_status_mail_authority(text,text)',
          'enqueue_backup_status_mail_authority',
          true,
          ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[],
          ARRAY[
            'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid
          ]::pg_catalog.oid[],
          ARRAY[
            'p_run_key', 'p_outcome', 'acknowledgement',
            'authority_id', 'outbox_id', 'operation_id'
          ]::pg_catalog.text[],
          ARRAY[
            'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid
          ]::pg_catalog.oid[],
          ARRAY['i', 'i', 't', 't', 't', 't']::pg_catalog.text[],
          'pg_catalog.record'::pg_catalog.regtype,
          true,
          1000::pg_catalog.float4,
          CASE
            WHEN successor_relation IS NULL THEN 'ac406b4dff127c10f791267c1464faddbe93e8ce88faa0a52c215881ac1b7480'
            ELSE '2cc0bf920b31af64566f1eb0352bd63f078bcccab3d064748ba5af226805c81b'
          END,
          NULL::pg_catalog.text,
          ARRAY[
            'learncoding_backup_reporter|learncoding_owner|execute|f',
            'learncoding_owner|learncoding_owner|execute|f'
          ]::pg_catalog.text[]
        ),
        (
          'public.backup_status_mail_authorized(uuid)',
          'backup_status_mail_authorized',
          true,
          ARRAY['search_path=pg_catalog']::pg_catalog.text[],
          ARRAY[
            'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid
          ]::pg_catalog.oid[],
          ARRAY['p_candidate_outbox_id']::pg_catalog.text[],
          NULL::pg_catalog.oid[],
          NULL::pg_catalog.text[],
          'pg_catalog.bool'::pg_catalog.regtype,
          false,
          0::pg_catalog.float4,
          'c947fcc0d019174fcb76c39d61fa736bd552dd6f2eeae6f46cfc772aa4dc95ae',
          'bb7765a31c1e9e2796e554cb1445ddeba3f8ff078e210312486b817db1da4180',
          ARRAY[
            'learncoding_owner|learncoding_owner|execute|f',
            'learncoding_worker|learncoding_owner|execute|f'
          ]::pg_catalog.text[]
        )
    ),
    actual_backup_routines AS (
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
        ARRAY(
          SELECT input_type::pg_catalog.oid
            FROM pg_catalog.unnest(routine.proargtypes) AS input_type
        )::pg_catalog.oid[] AS actual_input_types,
        routine.proargnames,
        routine.proallargtypes,
        CASE WHEN routine.proargmodes IS NULL THEN NULL::pg_catalog.text[]
             ELSE ARRAY(
               SELECT mode::pg_catalog.text
                 FROM pg_catalog.unnest(routine.proargmodes) AS mode
             )::pg_catalog.text[] END AS actual_argument_modes,
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
        CASE WHEN expected.definition_sha256 IS NULL THEN NULL::pg_catalog.text
             ELSE pg_catalog.encode(
               pg_catalog.sha256(pg_catalog.convert_to(
                 pg_catalog.pg_get_functiondef(routine.oid), 'UTF8'
               )), 'hex'
             ) END AS actual_definition_sha256,
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
                FROM pg_catalog.aclexplode(COALESCE(
                       routine.proacl,
                       pg_catalog.acldefault('f', routine.proowner)
                     )) AS access
            ) AS serialized
        ), ARRAY[]::pg_catalog.text[]) AS actual_execute_acl,
        (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS overload
          WHERE overload.pronamespace = 'public'::pg_catalog.regnamespace
            AND overload.proname = expected.routine_name) AS overload_count
        FROM expected_backup_routines AS expected
        LEFT JOIN pg_catalog.pg_proc AS routine
          ON routine.oid = pg_catalog.to_regprocedure(expected.identity)
        LEFT JOIN pg_catalog.pg_language AS language ON language.oid = routine.prolang
    )
    SELECT 1
      FROM actual_backup_routines AS actual
     WHERE actual.routine_oid IS NULL
        OR actual.owner_name IS DISTINCT FROM 'learncoding_owner'
        OR actual.language_name IS DISTINCT FROM 'plpgsql'
        OR actual.prokind IS DISTINCT FROM 'f'
        OR actual.provolatile IS DISTINCT FROM 'v'
        OR actual.proisstrict
        OR actual.proparallel IS DISTINCT FROM 'u'
        OR actual.proleakproof
        OR actual.prosecdef IS DISTINCT FROM actual.security_definer
        OR actual.proconfig IS DISTINCT FROM actual.settings
        OR actual.actual_input_types IS DISTINCT FROM actual.input_types
        OR actual.proargnames IS DISTINCT FROM actual.argument_names
        OR actual.proallargtypes IS DISTINCT FROM actual.all_argument_types
        OR actual.actual_argument_modes IS DISTINCT FROM actual.argument_modes
        OR actual.prorettype IS DISTINCT FROM actual.return_type
        OR actual.proretset IS DISTINCT FROM actual.returns_set
        OR actual.pronargs IS DISTINCT FROM
             pg_catalog.cardinality(actual.input_types)
        OR actual.pronargdefaults <> 0
        OR actual.proargdefaults IS NOT NULL
        OR actual.provariadic <> 0
        OR actual.procost <> 100
        OR actual.prorows IS DISTINCT FROM actual.expected_rows
        OR actual.prosupport <> 0
        OR actual.protrftypes IS NOT NULL
        OR actual.probin IS NOT NULL
        OR actual.prosqlbody IS NOT NULL
        OR actual.actual_source_sha256 IS DISTINCT FROM actual.source_sha256
        OR actual.actual_definition_sha256 IS DISTINCT FROM
             actual.definition_sha256
        OR actual.actual_execute_acl IS DISTINCT FROM actual.execute_acl
        OR actual.overload_count <> 1
  )
  THEN
    RAISE EXCEPTION '0069 inherited Task 5 backup routines are invalid'
      USING ERRCODE = '42501';
  END IF;

  SELECT pg_catalog.count(*)::pg_catalog.int4
    INTO successor_columns
    FROM pg_catalog.pg_attribute AS attribute
   WHERE attribute.attrelid = 'public.email_outbox'::pg_catalog.regclass
     AND attribute.attname IN (
       'delivery_release_insert_xid',
       'delivery_release_insert_system_identifier',
       'provider_request_body_sha256',
       'provider_request_body_length'
     )
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped;

  SELECT pg_catalog.count(*)::pg_catalog.int4
    INTO successor_routines
    FROM (VALUES
      ('public.mail_delivery_release_receipt_sha256(uuid,uuid,text,text,text,text)'::pg_catalog.text),
      ('public.enforce_email_outbox_delivery_release_insert_xid()'),
      ('public.enforce_email_outbox_delivery_release_identity()'),
      ('public.enforce_email_outbox_delivery_release_insert_final()'),
      ('public.enforce_mail_delivery_release_receipt_append_only()'),
      ('public.enforce_mail_delivery_release_receipt_insert()'),
      ('public.release_email_outbox_delivery(uuid,uuid,text,text,text)'),
      ('public.verify_email_outbox_delivery_release(uuid,uuid,text,text,text)'),
      ('public.attest_email_outbox_delivery_release_lineage(text)'),
      ('public.enforce_email_outbox_delivery_release_commit_exact()'),
      ('public.enforce_mail_delivery_release_receipt_delete_exact()'),
      ('public.enforce_email_outbox_delivery_release_delete_exact()'),
      ('public.enforce_email_outbox_provider_request_body_immutable()'),
      ('public.enqueue_backup_status_mail_authority_unreleased_0067(text,text)')
    ) AS expected(identity)
   WHERE pg_catalog.to_regprocedure(expected.identity) IS NOT NULL;

  SELECT pg_catalog.count(*)::pg_catalog.int4
    INTO successor_triggers
    FROM (VALUES
      (
        'email_outbox_delivery_release_insert_xid'::pg_catalog.text,
        'public.email_outbox'::pg_catalog.regclass,
        'public.enforce_email_outbox_delivery_release_insert_xid()'::pg_catalog.text,
        7::pg_catalog.int2,
        ARRAY[]::pg_catalog.int2[]
      ),
      (
        'email_outbox_delivery_release_insert_xid_immutable',
        'public.email_outbox'::pg_catalog.regclass,
        'public.enforce_email_outbox_delivery_release_insert_xid()',
        19::pg_catalog.int2,
        ARRAY[34, 37, 13]::pg_catalog.int2[]
      ),
      (
        'zz_email_outbox_delivery_release_identity',
        'public.email_outbox'::pg_catalog.regclass,
        'public.enforce_email_outbox_delivery_release_identity()',
        7::pg_catalog.int2,
        ARRAY[]::pg_catalog.int2[]
      ),
      (
        'zz_email_outbox_delivery_release_insert_final',
        'public.email_outbox'::pg_catalog.regclass,
        'public.enforce_email_outbox_delivery_release_insert_final()',
        5::pg_catalog.int2,
        ARRAY[]::pg_catalog.int2[]
      ),
      (
        'email_outbox_provider_request_body_immutable',
        'public.email_outbox'::pg_catalog.regclass,
        'public.enforce_email_outbox_provider_request_body_immutable()',
        23::pg_catalog.int2,
        ARRAY[20, 35, 36]::pg_catalog.int2[]
      ),
      (
        'email_outbox_delivery_hold_final',
        'public.email_outbox'::pg_catalog.regclass,
        'public.enforce_email_outbox_delivery_hold()',
        17::pg_catalog.int2,
        ARRAY[]::pg_catalog.int2[]
      ),
      (
        'mail_delivery_release_receipt_insert_authority',
        successor_relation,
        'public.enforce_mail_delivery_release_receipt_insert()',
        7::pg_catalog.int2,
        ARRAY[]::pg_catalog.int2[]
      ),
      (
        'mail_delivery_release_receipt_append_only',
        successor_relation,
        'public.enforce_mail_delivery_release_receipt_append_only()',
        19::pg_catalog.int2,
        ARRAY[]::pg_catalog.int2[]
      ),
      (
        'mail_delivery_release_receipt_no_truncate',
        successor_relation,
        'public.enforce_mail_delivery_release_receipt_append_only()',
        34::pg_catalog.int2,
        ARRAY[]::pg_catalog.int2[]
      ),
      (
        'email_outbox_delivery_release_commit_exact',
        'public.email_outbox'::pg_catalog.regclass,
        'public.enforce_email_outbox_delivery_release_commit_exact()',
        5::pg_catalog.int2,
        ARRAY[]::pg_catalog.int2[]
      ),
      (
        'mail_delivery_release_receipt_delete_exact',
        successor_relation,
        'public.enforce_mail_delivery_release_receipt_delete_exact()',
        9::pg_catalog.int2,
        ARRAY[]::pg_catalog.int2[]
      ),
      (
        'email_outbox_delivery_release_delete_exact',
        'public.email_outbox'::pg_catalog.regclass,
        'public.enforce_email_outbox_delivery_release_delete_exact()',
        9::pg_catalog.int2,
        ARRAY[]::pg_catalog.int2[]
      )
    ) AS expected(
      trigger_name,
      relation_oid,
      function_identity,
      trigger_type,
      watched_columns
    )
    JOIN pg_catalog.pg_trigger AS trigger_row
      ON trigger_row.tgrelid = expected.relation_oid
     AND trigger_row.tgname = expected.trigger_name
   WHERE NOT trigger_row.tgisinternal
     AND trigger_row.tgconstrindid = 0
     AND trigger_row.tgparentid = 0
     AND (
       (
         expected.trigger_name IN (
           'email_outbox_delivery_release_commit_exact',
           'mail_delivery_release_receipt_delete_exact',
           'email_outbox_delivery_release_delete_exact'
         )
         AND trigger_row.tgconstraint <> 0
         AND trigger_row.tgconstrrelid = 0
         AND trigger_row.tgdeferrable
         AND trigger_row.tginitdeferred
         AND EXISTS (
           SELECT 1
             FROM pg_catalog.pg_constraint AS trigger_constraint
            WHERE trigger_constraint.oid = trigger_row.tgconstraint
              AND trigger_constraint.conrelid = trigger_row.tgrelid
              AND trigger_constraint.connamespace =
                    'public'::pg_catalog.regnamespace
              AND trigger_constraint.conname = trigger_row.tgname
              AND trigger_constraint.contype = 't'
              AND trigger_constraint.condeferrable
              AND trigger_constraint.condeferred
              AND trigger_constraint.convalidated
         )
       )
       OR (
         expected.trigger_name NOT IN (
           'email_outbox_delivery_release_commit_exact',
           'mail_delivery_release_receipt_delete_exact',
           'email_outbox_delivery_release_delete_exact'
         )
         AND trigger_row.tgconstraint = 0
         AND trigger_row.tgconstrrelid = 0
         AND NOT trigger_row.tgdeferrable
         AND NOT trigger_row.tginitdeferred
       )
     )
     AND trigger_row.tgqual IS NULL
     AND trigger_row.tgoldtable IS NULL
     AND trigger_row.tgnewtable IS NULL
     AND trigger_row.tgtype = expected.trigger_type
     AND trigger_row.tgenabled = 'A'
     AND trigger_row.tgnargs = 0
     AND pg_catalog.octet_length(trigger_row.tgargs) = 0
     AND trigger_row.tgfoid =
           pg_catalog.to_regprocedure(expected.function_identity)
     AND COALESCE(
           (
             SELECT pg_catalog.array_agg(
                      watched.attnum ORDER BY watched.ordinality
                    )
               FROM pg_catalog.unnest(
                      trigger_row.tgattr::pg_catalog.int2[]
                    ) WITH ORDINALITY AS watched(attnum, ordinality)
           ),
           ARRAY[]::pg_catalog.int2[]
         ) = expected.watched_columns;

  SELECT pg_catalog.count(*)::pg_catalog.int4
    INTO successor_constraints
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid = 'public.email_outbox'::pg_catalog.regclass
     AND constraint_row.connamespace = 'public'::pg_catalog.regnamespace
     AND constraint_row.conname IN (
       'email_outbox_delivery_release_parent_unique',
       'email_outbox_provider_request_body_valid',
       'email_outbox_delivery_release_insert_identity_valid',
       'email_outbox_attempt_count_nonnegative'
     )
     AND constraint_row.contype IN ('c', 'u')
     AND constraint_row.convalidated
     AND constraint_row.conislocal
     AND constraint_row.coninhcount = 0
     AND constraint_row.conparentid = 0;

  IF successor_relation IS NULL
     AND successor_columns = 0
     AND successor_routines = 0
     AND successor_triggers = 0
     AND successor_constraints = 0
  THEN
    IF EXISTS (
      SELECT 1
        FROM ONLY public.email_outbox AS outbox
       WHERE outbox.status IS NULL
          OR outbox.status NOT IN ('sent', 'failed', 'suppressed')
    ) THEN
      RAISE EXCEPTION '0069 requires a drained nonterminal outbox backlog'
        USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_proc AS routine
        JOIN pg_catalog.pg_language AS language
          ON language.oid = routine.prolang
       WHERE routine.oid = hold_oid
         AND pg_catalog.pg_get_userbyid(routine.proowner) =
               'learncoding_owner'
         AND routine.prosecdef
         AND routine.provolatile = 'v'
         AND routine.proconfig =
               ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
         AND language.lanname = 'plpgsql'
         AND pg_catalog.encode(
               pg_catalog.sha256(
                 pg_catalog.convert_to(routine.prosrc, 'UTF8')
               ),
               'hex'
             ) =
               'bf644f8a69cea40011d7268ac8f14d8775045fe923cb2ca5f06a9cd25a39c8e8'
         AND pg_catalog.encode(
               pg_catalog.sha256(
                 pg_catalog.convert_to(
                   pg_catalog.pg_get_functiondef(routine.oid),
                   'UTF8'
                 )
               ),
               'hex'
             ) =
               '9af2d218cd9a189c84db693acefefa10826d796058505cce85124d6830d6fe53'
    ) THEN
      RAISE EXCEPTION '0069 predecessor hold authority is invalid'
        USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_proc AS routine
       WHERE routine.oid = pg_catalog.to_regprocedure(
               'public.enforce_email_outbox_payload_immutable()'
             )
         AND pg_catalog.pg_get_userbyid(routine.proowner) =
               'learncoding_owner'
         AND NOT routine.prosecdef
         AND routine.provolatile = 'v'
         AND routine.proconfig =
               ARRAY['search_path=pg_catalog']::pg_catalog.text[]
         AND pg_catalog.encode(
               pg_catalog.sha256(
                 pg_catalog.convert_to(routine.prosrc, 'UTF8')
               ),
               'hex'
             ) =
               'bc7518bd7a4aaa294ac72945abc0b5001957f47a581f6e9b69037b82894528cb'
    )
    OR NOT EXISTS (
      SELECT 1
        FROM pg_catalog.pg_proc AS routine
       WHERE routine.oid = pg_catalog.to_regprocedure(
               'public.enqueue_backup_status_mail_authority(text,text)'
             )
         AND pg_catalog.pg_get_userbyid(routine.proowner) =
               'learncoding_owner'
         AND routine.prosecdef
         AND routine.provolatile = 'v'
         AND routine.proconfig =
               ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
         AND pg_catalog.encode(
               pg_catalog.sha256(
                 pg_catalog.convert_to(routine.prosrc, 'UTF8')
               ),
               'hex'
             ) =
               'ac406b4dff127c10f791267c1464faddbe93e8ce88faa0a52c215881ac1b7480'
    )
    THEN
      RAISE EXCEPTION '0069 exact predecessor routines are invalid'
        USING ERRCODE = '42501';
    END IF;
  ELSIF successor_relation IS NOT NULL
        AND successor_columns = 4
        AND successor_routines = 14
        AND successor_triggers = 12
        AND successor_constraints = 4
  THEN
    IF NOT EXISTS (
         SELECT 1
           FROM pg_catalog.pg_class AS relation
          WHERE relation.oid = successor_relation
            AND relation.relkind = 'r'
            AND relation.relpersistence = 'p'
            AND NOT relation.relrowsecurity
            AND NOT relation.relforcerowsecurity
            AND pg_catalog.pg_get_userbyid(relation.relowner) =
                  'learncoding_owner'
       )
       OR NOT EXISTS (
         SELECT 1
           FROM pg_catalog.pg_proc AS routine
           JOIN pg_catalog.pg_language AS language
             ON language.oid = routine.prolang
          WHERE routine.oid = hold_oid
            AND pg_catalog.pg_get_userbyid(routine.proowner) =
                  'learncoding_owner'
            AND routine.prokind = 'f'
            AND routine.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
            AND NOT routine.proretset
            AND routine.prosecdef
            AND routine.provolatile = 'v'
            AND NOT routine.proisstrict
            AND routine.proparallel = 'u'
            AND routine.proconfig =
                  ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
            AND language.lanname = 'plpgsql'
            AND routine.pronargs = 0
            AND routine.pronargdefaults = 0
            AND routine.provariadic = 0
            AND NOT routine.proleakproof
            AND routine.prosupport = 0
            AND routine.probin IS NULL
            AND routine.prosqlbody IS NULL
            AND pg_catalog.encode(
                  pg_catalog.sha256(
                    pg_catalog.convert_to(routine.prosrc, 'UTF8')
                  ),
                  'hex'
                ) =
                  '7636ab37cc17692c0c31d160dc5d7f0421d6660c0da2dfb6a2d8cae4501ea4e1'
       )
       OR (
         SELECT pg_catalog.count(*)
           FROM pg_catalog.pg_constraint AS constraint_row
          WHERE constraint_row.conrelid = successor_relation
            AND constraint_row.conname IN (
              'mail_delivery_release_receipt_pkey',
              'mail_delivery_release_receipt_operation_unique',
              'mail_delivery_release_receipt_digest_unique',
              'mail_delivery_release_receipt_authority_version_valid',
              'mail_delivery_release_receipt_release_version_valid',
              'mail_delivery_release_receipt_digest_valid',
              'mail_delivery_release_receipt_digest_exact',
              'mail_delivery_release_receipt_outbox_fk',
              'mail_delivery_release_receipt_idempotency_authority_fk'
            )
            AND constraint_row.convalidated
       ) <> 9
       OR NOT EXISTS (
         SELECT 1
           FROM pg_catalog.pg_constraint AS parent_identity
           JOIN pg_catalog.pg_class AS index_relation
             ON index_relation.oid = parent_identity.conindid
           JOIN pg_catalog.pg_index AS index_row
             ON index_row.indexrelid = index_relation.oid
           JOIN pg_catalog.pg_am AS access_method
             ON access_method.oid = index_relation.relam
          WHERE parent_identity.conrelid =
                'public.email_outbox'::pg_catalog.regclass
            AND parent_identity.connamespace = 'public'::pg_catalog.regnamespace
            AND parent_identity.conname =
                  'email_outbox_delivery_release_parent_unique'
            AND parent_identity.contype = 'u'
            AND parent_identity.conkey = ARRAY[1, 15]::pg_catalog.int2[]
            AND parent_identity.conindid =
                  'public.email_outbox_delivery_release_parent_unique'
                    ::pg_catalog.regclass
            AND parent_identity.convalidated
            AND parent_identity.conislocal
            AND parent_identity.coninhcount = 0
            AND parent_identity.conparentid = 0
            AND parent_identity.connoinherit
            AND NOT parent_identity.condeferrable
            AND NOT parent_identity.condeferred
            AND parent_identity.contypid = 0
            AND parent_identity.confrelid = 0
            AND parent_identity.conbin IS NULL
            AND pg_catalog.encode(
                  pg_catalog.sha256(
                    pg_catalog.convert_to(
                      pg_catalog.pg_get_constraintdef(parent_identity.oid, false),
                      'UTF8'
                    )
                  ),
                  'hex'
                ) = '2f5fa6b88fc8018a513ab5b1c5e1cf4c6f882c4463a08e04b8916f0ddd484b2b'
            AND index_relation.relkind = 'i'
            AND index_relation.relpersistence = 'p'
            AND pg_catalog.pg_get_userbyid(index_relation.relowner) =
                  'learncoding_owner'
            AND access_method.amname = 'btree'
            AND index_row.indrelid =
                  'public.email_outbox'::pg_catalog.regclass
            AND index_row.indisunique
            AND NOT index_row.indisprimary
            AND NOT index_row.indisexclusion
            AND index_row.indimmediate
            AND index_row.indisvalid
            AND index_row.indisready
            AND index_row.indislive
            AND NOT index_row.indisclustered
            AND NOT index_row.indisreplident
            AND NOT index_row.indcheckxmin
            AND NOT index_row.indnullsnotdistinct
            AND index_row.indnkeyatts = 2
            AND index_row.indnatts = 2
            AND index_row.indkey::pg_catalog.text = '1 15'
            AND index_row.indexprs IS NULL
            AND index_row.indpred IS NULL
            AND pg_catalog.encode(
                  pg_catalog.sha256(
                    pg_catalog.convert_to(
                      pg_catalog.pg_get_indexdef(index_row.indexrelid),
                      'UTF8'
                    )
                  ),
                  'hex'
                ) = 'b953dc6f2b39756fa0a4a2dd962d37172381802f2d4bc86fce2847de0457c7ee'
       )
       OR NOT EXISTS (
         SELECT 1
           FROM pg_catalog.pg_constraint AS foreign_key
          WHERE foreign_key.conrelid = successor_relation
            AND foreign_key.connamespace = 'public'::pg_catalog.regnamespace
            AND foreign_key.conname =
                  'mail_delivery_release_receipt_outbox_fk'
            AND foreign_key.contype = 'f'
            AND foreign_key.confrelid =
                  'public.email_outbox'::pg_catalog.regclass
            AND foreign_key.conkey = ARRAY[1, 2]::pg_catalog.int2[]
            AND foreign_key.confkey = ARRAY[1, 15]::pg_catalog.int2[]
            AND foreign_key.conindid =
                  'public.email_outbox_delivery_release_parent_unique'
                    ::pg_catalog.regclass
            AND foreign_key.convalidated
            AND foreign_key.conislocal
            AND foreign_key.coninhcount = 0
            AND foreign_key.conparentid = 0
            AND foreign_key.connoinherit
            AND NOT foreign_key.condeferrable
            AND NOT foreign_key.condeferred
            AND foreign_key.confupdtype = 'r'
            AND foreign_key.confdeltype = 'c'
            AND foreign_key.confmatchtype = 's'
            AND pg_catalog.encode(
                  pg_catalog.sha256(
                    pg_catalog.convert_to(
                      pg_catalog.pg_get_constraintdef(foreign_key.oid, false),
                      'UTF8'
                    )
                  ),
                  'hex'
                ) = 'a404224075eb2229356afced34903caa44c5621308b335ec68fa36104584cc4b'
       )
    THEN
      RAISE EXCEPTION '0069 exact successor catalog is invalid'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION '0069 predecessor/successor catalog is mixed or partial'
      USING ERRCODE = '23514';
  END IF;
END
$preflight$;--> statement-breakpoint

DO $add_guarded_delivery_columns$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = 'public.email_outbox'::pg_catalog.regclass
       AND attribute.attname = 'delivery_release_insert_xid'
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
  ) THEN
    EXECUTE $ddl$
      ALTER TABLE ONLY public.email_outbox
        ADD COLUMN delivery_release_insert_xid pg_catalog.xid8,
        ADD COLUMN provider_request_body_sha256 pg_catalog.text,
        ADD COLUMN provider_request_body_length pg_catalog.int8,
        ADD COLUMN delivery_release_insert_system_identifier pg_catalog.int8
    $ddl$;
  END IF;
END
$add_guarded_delivery_columns$;--> statement-breakpoint

DO $add_request_body_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid =
             'public.email_outbox'::pg_catalog.regclass
       AND constraint_row.conname =
             'email_outbox_provider_request_body_valid'
  ) THEN
    EXECUTE $ddl$
      ALTER TABLE ONLY public.email_outbox
        ADD CONSTRAINT email_outbox_provider_request_body_valid
        CHECK ((
          (
            provider_request_body_sha256 IS NULL
            AND provider_request_body_length IS NULL
          )
          OR (
            provider_request_body_sha256 IS NOT NULL
            AND provider_request_body_length IS NOT NULL
            AND provider_request_body_sha256 ~ '^[0-9a-f]{64}$'
            AND provider_request_body_length >= 0
            AND provider_request_body_length <= 9007199254740991
          )
        ) IS TRUE) NOT VALID
    $ddl$;
  END IF;
END
$add_request_body_constraint$;--> statement-breakpoint
ALTER TABLE ONLY public.email_outbox
  VALIDATE CONSTRAINT email_outbox_provider_request_body_valid;--> statement-breakpoint

DO $add_delivery_release_insert_identity_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid =
             'public.email_outbox'::pg_catalog.regclass
       AND constraint_row.conname =
             'email_outbox_delivery_release_insert_identity_valid'
  ) THEN
    EXECUTE $ddl$
      ALTER TABLE ONLY public.email_outbox
        ADD CONSTRAINT email_outbox_delivery_release_insert_identity_valid
        CHECK (((
          delivery_release_insert_xid IS NULL
          AND delivery_release_insert_system_identifier IS NULL
        ) OR (
          delivery_release_insert_xid IS NOT NULL
          AND delivery_release_insert_system_identifier IS NOT NULL
        )) IS TRUE) NOT VALID
    $ddl$;
  END IF;
END
$add_delivery_release_insert_identity_constraint$;--> statement-breakpoint
ALTER TABLE ONLY public.email_outbox
  VALIDATE CONSTRAINT
    email_outbox_delivery_release_insert_identity_valid;--> statement-breakpoint
DO $add_attempt_count_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid =
             'public.email_outbox'::pg_catalog.regclass
       AND constraint_row.conname = 'email_outbox_attempt_count_nonnegative'
  ) THEN
    EXECUTE $ddl$
      ALTER TABLE ONLY public.email_outbox
        ADD CONSTRAINT email_outbox_attempt_count_nonnegative
        CHECK ((attempt_count >= 0) IS TRUE) NOT VALID
    $ddl$;
  END IF;
END
$add_attempt_count_constraint$;--> statement-breakpoint
ALTER TABLE ONLY public.email_outbox
  VALIDATE CONSTRAINT
    email_outbox_attempt_count_nonnegative;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.mail_delivery_release_receipt_sha256(
  input_outbox_id pg_catalog.uuid,
  input_operation_id pg_catalog.uuid,
  input_authority_version pg_catalog.text,
  input_authority_sha256 pg_catalog.text,
  input_original_payload_sha256 pg_catalog.text,
  input_release_version pg_catalog.text
)
RETURNS pg_catalog.text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        'mail-delivery-release-v1' || pg_catalog.chr(10)
        || input_outbox_id::pg_catalog.text || pg_catalog.chr(10)
        || input_operation_id::pg_catalog.text || pg_catalog.chr(10)
        || input_authority_version || pg_catalog.chr(10)
        || input_authority_sha256 || pg_catalog.chr(10)
        || input_original_payload_sha256 || pg_catalog.chr(10)
        || input_release_version,
        'UTF8'
      )
    ),
    'hex'
  )
$function$;--> statement-breakpoint

DO $create_release_parent_identity$
BEGIN
  IF pg_catalog.to_regclass(
       'public.mail_delivery_release_receipt'
     ) IS NULL
  THEN
    ALTER TABLE ONLY public.email_outbox
      ADD CONSTRAINT email_outbox_delivery_release_parent_unique
      UNIQUE (id, operation_id);
  END IF;
END
$create_release_parent_identity$;--> statement-breakpoint
DO $create_release_relation$
BEGIN
  IF pg_catalog.to_regclass(
       'public.mail_delivery_release_receipt'
     ) IS NULL
  THEN
    EXECUTE $ddl$
      CREATE TABLE public.mail_delivery_release_receipt (
        outbox_id pg_catalog.uuid NOT NULL,
        operation_id pg_catalog.uuid NOT NULL,
        idempotency_authority_version pg_catalog.text NOT NULL,
        idempotency_authority_sha256 pg_catalog.text NOT NULL,
        idempotency_original_payload_sha256 pg_catalog.text NOT NULL,
        release_version pg_catalog.text NOT NULL,
        release_receipt_sha256 pg_catalog.text NOT NULL,
        released_at timestamp with time zone NOT NULL
          DEFAULT pg_catalog.statement_timestamp(),
        CONSTRAINT mail_delivery_release_receipt_pkey
          PRIMARY KEY (outbox_id),
        CONSTRAINT mail_delivery_release_receipt_operation_unique
          UNIQUE (operation_id),
        CONSTRAINT mail_delivery_release_receipt_digest_unique
          UNIQUE (release_receipt_sha256),
        CONSTRAINT mail_delivery_release_receipt_authority_version_valid
          CHECK ((
            idempotency_authority_version IN (
              'event-v1-native', 'event-v1-source-map'
            )
            AND idempotency_authority_sha256 ~ '^[0-9a-f]{64}$'
            AND idempotency_original_payload_sha256 ~ '^[0-9a-f]{64}$'
          ) IS TRUE),
        CONSTRAINT mail_delivery_release_receipt_release_version_valid
          CHECK ((release_version = 'task7-v1') IS TRUE),
        CONSTRAINT mail_delivery_release_receipt_digest_valid
          CHECK ((
            release_receipt_sha256 ~ '^[0-9a-f]{64}$'
          ) IS TRUE),
        CONSTRAINT mail_delivery_release_receipt_outbox_fk
          FOREIGN KEY (outbox_id, operation_id)
          REFERENCES public.email_outbox (id, operation_id)
          ON UPDATE RESTRICT
          ON DELETE CASCADE
          NOT DEFERRABLE,
        CONSTRAINT mail_delivery_release_receipt_digest_exact
          CHECK ((
            release_receipt_sha256 =
              public.mail_delivery_release_receipt_sha256(
                outbox_id,
                operation_id,
                idempotency_authority_version,
                idempotency_authority_sha256,
                idempotency_original_payload_sha256,
                release_version
              )
          ) IS TRUE),
        CONSTRAINT mail_delivery_release_receipt_idempotency_authority_fk
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
      ) USING heap
    $ddl$;
  END IF;
END
$create_release_relation$;--> statement-breakpoint
ALTER TABLE public.mail_delivery_release_receipt
  OWNER TO learncoding_owner;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS
  mail_delivery_release_receipt_authority_fk_idx
ON public.mail_delivery_release_receipt USING btree (
  idempotency_authority_sha256,
  idempotency_original_payload_sha256
);--> statement-breakpoint

CREATE OR REPLACE FUNCTION
  public.enforce_email_outbox_delivery_release_insert_xid()
RETURNS pg_catalog.trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
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
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'email outbox delivery release insert xid is immutable'
    USING ERRCODE = '23514';
END
$function$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION
  public.enforce_email_outbox_delivery_release_identity()
RETURNS pg_catalog.trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  current_system_identifier pg_catalog.int8;
BEGIN
  SELECT control.system_identifier
    INTO STRICT current_system_identifier
    FROM pg_catalog.pg_control_system() AS control;
  IF TG_OP IS DISTINCT FROM 'INSERT'
     OR TG_RELID IS DISTINCT FROM 'public.email_outbox'::pg_catalog.regclass
  THEN
    RAISE EXCEPTION 'email outbox delivery release identity guard is misbound'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.delivery_release_insert_xid
       IS DISTINCT FROM pg_catalog.pg_current_xact_id()
     OR NEW.delivery_release_insert_system_identifier
          IS DISTINCT FROM current_system_identifier
  THEN
    RAISE EXCEPTION 'email outbox delivery release insert identity is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM ONLY public.mail_delivery_release_receipt AS release
     WHERE release.outbox_id = NEW.id
        OR release.operation_id = NEW.operation_id
  ) THEN
    RAISE EXCEPTION 'email outbox identity has a durable release receipt'
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END
$function$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION
  public.enforce_email_outbox_delivery_release_insert_final()
RETURNS pg_catalog.trigger
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  candidate public.email_outbox%ROWTYPE;
  current_system_identifier pg_catalog.int8;
BEGIN
  IF TG_OP IS DISTINCT FROM 'INSERT'
     OR TG_RELID IS DISTINCT FROM 'public.email_outbox'::pg_catalog.regclass
  THEN
    RAISE EXCEPTION 'email outbox delivery release final insert guard is misbound'
      USING ERRCODE = '23514';
  END IF;

  SELECT control.system_identifier
    INTO STRICT current_system_identifier
    FROM pg_catalog.pg_control_system() AS control;

  SELECT outbox.*
    INTO candidate
    FROM ONLY public.email_outbox AS outbox
   WHERE outbox.id = NEW.id
     AND outbox.operation_id = NEW.operation_id;

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
     OR candidate.delivery_hold_version IS DISTINCT FROM 'task7-v1'
     OR candidate.idempotency_authority_version NOT IN (
       'event-v1-native', 'event-v1-source-map'
     )
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
     OR NOT EXISTS (
       SELECT 1
         FROM ONLY public.email_outbox_idempotency_authority AS authority
        WHERE authority.idempotency_sha256 =
                candidate.idempotency_authority_sha256
          AND authority.original_payload_sha256 =
                candidate.idempotency_original_payload_sha256
     )
  THEN
    RAISE EXCEPTION 'email outbox delivery release final insert state is invalid'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END
$function$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION
  public.enforce_mail_delivery_release_receipt_append_only()
RETURNS pg_catalog.trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'mail delivery release receipts are append-only'
    USING ERRCODE = '23514';
END
$function$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION
  public.enforce_mail_delivery_release_receipt_insert()
RETURNS pg_catalog.trigger
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
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
     )
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
$function$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.release_email_outbox_delivery(
  requested_outbox_id pg_catalog.uuid,
  requested_operation_id pg_catalog.uuid,
  requested_authority_sha256 pg_catalog.text,
  requested_original_payload_sha256 pg_catalog.text,
  requested_release_version pg_catalog.text
)
RETURNS public.mail_delivery_release_receipt
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
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
     )
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
$function$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.verify_email_outbox_delivery_release(
  requested_outbox_id pg_catalog.uuid,
  requested_operation_id pg_catalog.uuid,
  requested_authority_sha256 pg_catalog.text,
  requested_original_payload_sha256 pg_catalog.text,
  requested_release_version pg_catalog.text
)
RETURNS TABLE (
  outbox_id pg_catalog.uuid,
  operation_id pg_catalog.uuid
)
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  candidate public.email_outbox%ROWTYPE;
  existing_receipt public.mail_delivery_release_receipt%ROWTYPE;
  conflicting_receipts pg_catalog.int4;
BEGIN
  IF current_user IS DISTINCT FROM 'learncoding_owner'
     OR session_user NOT IN (
       'learncoding_app',
       'learncoding_owner'
     )
  THEN
    RAISE EXCEPTION 'email outbox delivery release verifier caller is invalid'
      USING ERRCODE = '42501';
  END IF;

  IF requested_outbox_id IS NULL
     OR requested_operation_id IS NULL
     OR requested_authority_sha256 IS NULL
     OR requested_authority_sha256 !~ '^[0-9a-f]{64}$'
     OR requested_original_payload_sha256 IS NULL
     OR requested_original_payload_sha256 !~ '^[0-9a-f]{64}$'
     OR requested_release_version IS DISTINCT FROM 'task7-v1'
  THEN
    RAISE EXCEPTION 'email outbox delivery release verifier arguments are invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT pg_catalog.count(*)::pg_catalog.int4
    INTO conflicting_receipts
    FROM ONLY public.mail_delivery_release_receipt AS release
   WHERE release.outbox_id = requested_outbox_id
      OR release.operation_id = requested_operation_id;

  IF conflicting_receipts <> 1 THEN
    RAISE EXCEPTION 'email outbox delivery release verifier receipt is missing or conflicts'
      USING ERRCODE = '23514';
  END IF;

  SELECT outbox.*
    INTO candidate
    FROM ONLY public.email_outbox AS outbox
   WHERE outbox.id = requested_outbox_id
     AND outbox.operation_id = requested_operation_id
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'email outbox delivery release verifier candidate is missing'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT release.*
    INTO existing_receipt
    FROM ONLY public.mail_delivery_release_receipt AS release
   WHERE release.outbox_id = requested_outbox_id
     AND release.operation_id = requested_operation_id
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'email outbox delivery release verifier receipt is missing'
      USING ERRCODE = 'P0002';
  END IF;

  IF candidate.delivery_release_insert_xid IS NOT NULL
     OR candidate.delivery_release_insert_system_identifier IS NOT NULL
     OR candidate.idempotency_authority_version NOT IN (
       'event-v1-native', 'event-v1-source-map'
     )
     OR candidate.idempotency_authority_sha256
          IS DISTINCT FROM requested_authority_sha256
     OR candidate.idempotency_original_payload_sha256
          IS DISTINCT FROM requested_original_payload_sha256
     OR candidate.idempotency_original_payload_sha256 IS DISTINCT FROM
          public.email_outbox_original_payload_sha256(
            candidate.user_id,
            candidate.to_email,
            candidate.template,
            candidate.template_version,
            candidate.variables
          )
     OR candidate.delivery_hold_version
          IS DISTINCT FROM requested_release_version
     OR existing_receipt.outbox_id IS DISTINCT FROM candidate.id
     OR existing_receipt.operation_id
          IS DISTINCT FROM candidate.operation_id
     OR existing_receipt.idempotency_authority_version
          IS DISTINCT FROM candidate.idempotency_authority_version
     OR existing_receipt.idempotency_authority_sha256
          IS DISTINCT FROM candidate.idempotency_authority_sha256
     OR existing_receipt.idempotency_original_payload_sha256
          IS DISTINCT FROM candidate.idempotency_original_payload_sha256
     OR existing_receipt.release_version
          IS DISTINCT FROM candidate.delivery_hold_version
     OR existing_receipt.release_version
          IS DISTINCT FROM requested_release_version
     OR existing_receipt.release_receipt_sha256 IS DISTINCT FROM
          public.mail_delivery_release_receipt_sha256(
            candidate.id,
            candidate.operation_id,
            candidate.idempotency_authority_version,
            candidate.idempotency_authority_sha256,
            candidate.idempotency_original_payload_sha256,
            candidate.delivery_hold_version
          )
     OR pg_catalog.isfinite(existing_receipt.released_at)
          IS DISTINCT FROM true
     OR NOT EXISTS (
       SELECT 1
         FROM ONLY public.email_outbox_idempotency_authority AS authority
        WHERE authority.idempotency_sha256 =
                candidate.idempotency_authority_sha256
          AND authority.original_payload_sha256 =
                candidate.idempotency_original_payload_sha256
     )
  THEN
    RAISE EXCEPTION 'email outbox delivery release verifier identity is invalid'
      USING ERRCODE = '23514';
  END IF;

  outbox_id := candidate.id;
  operation_id := candidate.operation_id;
  RETURN NEXT;
END
$function$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION
  public.attest_email_outbox_delivery_release_lineage(
    candidate_migration_sha256 pg_catalog.text
  )
RETURNS TABLE (
  phase_0066_count pg_catalog.int4,
  phase_0067_count pg_catalog.int4,
  phase_0068_count pg_catalog.int4,
  phase_0069_count pg_catalog.int4,
  candidate_hash_count pg_catalog.int4,
  lineage_window_count pg_catalog.int4
)
LANGUAGE plpgsql
STABLE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
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
     )
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
$function$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION
  public.enforce_email_outbox_delivery_release_commit_exact()
RETURNS pg_catalog.trigger
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  candidate public.email_outbox%ROWTYPE;
  conflicting_receipts pg_catalog.int4;
  matching_receipts pg_catalog.int4;
BEGIN
  IF TG_OP IS DISTINCT FROM 'INSERT'
     OR TG_RELID IS DISTINCT FROM 'public.email_outbox'::pg_catalog.regclass
  THEN
    RAISE EXCEPTION 'email outbox delivery release commit guard is misbound'
      USING ERRCODE = '23514';
  END IF;

  SELECT outbox.*
    INTO candidate
    FROM ONLY public.email_outbox AS outbox
   WHERE outbox.id = NEW.id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF pg_catalog.isfinite(NEW.created_at) IS DISTINCT FROM true
     OR pg_catalog.isfinite(NEW.updated_at) IS DISTINCT FROM true
     OR pg_catalog.isfinite(NEW.next_attempt_at) IS DISTINCT FROM true
     OR NEW.created_at IS DISTINCT FROM pg_catalog.transaction_timestamp()
     OR NEW.updated_at IS DISTINCT FROM pg_catalog.transaction_timestamp()
     OR (
       NEW.next_attempt_at >= pg_catalog.transaction_timestamp()
       AND NEW.next_attempt_at <=
             pg_catalog.transaction_timestamp() + interval '5 minutes'
     ) IS DISTINCT FROM true
  THEN
    RAISE EXCEPTION 'email outbox initial timestamps are invalid'
      USING ERRCODE = '23514';
  END IF;


  SELECT
    pg_catalog.count(*) FILTER (
      WHERE release.outbox_id = candidate.id
        AND release.operation_id = candidate.operation_id
        AND release.idempotency_authority_version =
              candidate.idempotency_authority_version
        AND release.idempotency_authority_sha256 =
              candidate.idempotency_authority_sha256
        AND release.idempotency_original_payload_sha256 =
              candidate.idempotency_original_payload_sha256
        AND release.release_version = candidate.delivery_hold_version
        AND release.release_receipt_sha256 =
              public.mail_delivery_release_receipt_sha256(
                candidate.id,
                candidate.operation_id,
                candidate.idempotency_authority_version,
                candidate.idempotency_authority_sha256,
                candidate.idempotency_original_payload_sha256,
                candidate.delivery_hold_version
              )
    )::pg_catalog.int4,
    pg_catalog.count(*)::pg_catalog.int4
    INTO matching_receipts, conflicting_receipts
    FROM ONLY public.mail_delivery_release_receipt AS release
   WHERE release.outbox_id = candidate.id
      OR release.operation_id = candidate.operation_id;

  IF candidate.delivery_release_insert_xid IS NOT NULL
     OR candidate.delivery_release_insert_system_identifier IS NOT NULL
     OR candidate.idempotency_original_payload_sha256 IS DISTINCT FROM
          public.email_outbox_original_payload_sha256(
            candidate.user_id,
            candidate.to_email,
            candidate.template,
            candidate.template_version,
            candidate.variables
          )
     OR conflicting_receipts <> 1
     OR matching_receipts <> 1
  THEN
    RAISE EXCEPTION 'email outbox delivery release is incomplete at commit'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END
$function$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION
  public.enforce_mail_delivery_release_receipt_delete_exact()
RETURNS pg_catalog.trigger
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP IS DISTINCT FROM 'DELETE'
     OR TG_RELID IS DISTINCT FROM
          'public.mail_delivery_release_receipt'::pg_catalog.regclass
  THEN
    RAISE EXCEPTION 'mail delivery release receipt delete guard is misbound'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM ONLY public.email_outbox AS outbox
     WHERE outbox.id = OLD.outbox_id
       AND outbox.operation_id = OLD.operation_id
  ) THEN
    RAISE EXCEPTION 'mail delivery release receipt parent still exists'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END
$function$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION
  public.enforce_email_outbox_delivery_release_delete_exact()
RETURNS pg_catalog.trigger
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP IS DISTINCT FROM 'DELETE'
     OR TG_RELID IS DISTINCT FROM 'public.email_outbox'::pg_catalog.regclass
  THEN
    RAISE EXCEPTION 'email outbox delivery release delete guard is misbound'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM ONLY public.mail_delivery_release_receipt AS release
     WHERE (
             release.outbox_id = OLD.id
             OR release.operation_id = OLD.operation_id
           )
       AND NOT EXISTS (
         SELECT 1
           FROM ONLY public.email_outbox AS outbox
          WHERE outbox.id = release.outbox_id
            AND outbox.operation_id = release.operation_id
       )
  ) THEN
    RAISE EXCEPTION
      'email outbox deletion would orphan a durable release receipt'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END
$function$;--> statement-breakpoint
DO $freeze_backup_enqueue_predecessor$
BEGIN
  IF pg_catalog.to_regprocedure(
       'public.enqueue_backup_status_mail_authority_unreleased_0067(text,text)'
     ) IS NULL
  THEN
    IF pg_catalog.to_regprocedure(
         'public.enqueue_backup_status_mail_authority(text,text)'
       ) IS NULL
    THEN
      RAISE EXCEPTION '0069 backup enqueue predecessor is missing'
        USING ERRCODE = '23514';
    END IF;
    EXECUTE
      'ALTER FUNCTION public.enqueue_backup_status_mail_authority(pg_catalog.text, pg_catalog.text) RENAME TO enqueue_backup_status_mail_authority_unreleased_0067';
  ELSIF pg_catalog.to_regprocedure(
          'public.enqueue_backup_status_mail_authority(text,text)'
        ) IS NULL
  THEN
    RAISE EXCEPTION '0069 backup enqueue successor is incomplete'
      USING ERRCODE = '23514';
  END IF;
END
$freeze_backup_enqueue_predecessor$;--> statement-breakpoint

DO $reject_stranded_backup_status$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM ONLY public.backup_status_mail_authority AS source
      JOIN ONLY public.email_outbox AS outbox
        ON outbox.id = source.outbox_id
       AND outbox.operation_id = source.operation_id
      LEFT JOIN ONLY public.mail_delivery_release_receipt AS release
        ON release.outbox_id = outbox.id
       AND release.operation_id = outbox.operation_id
     WHERE (
             outbox.status IS NULL
             OR outbox.status NOT IN ('sent', 'failed', 'suppressed')
           )
       AND release.outbox_id IS NULL
  ) THEN
    RAISE EXCEPTION '0069 cannot strand nonterminal backup-status mail'
      USING ERRCODE = '23514';
  END IF;
END
$reject_stranded_backup_status$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.enqueue_backup_status_mail_authority(
  p_run_key pg_catalog.text,
  p_outcome pg_catalog.text
)
RETURNS TABLE(
  acknowledgement pg_catalog.text,
  authority_id pg_catalog.uuid,
  outbox_id pg_catalog.uuid,
  operation_id pg_catalog.uuid
)
LANGUAGE plpgsql
VOLATILE
PARALLEL UNSAFE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  result_acknowledgement pg_catalog.text;
  result_authority_id pg_catalog.uuid;
  result_outbox_id pg_catalog.uuid;
  result_operation_id pg_catalog.uuid;
  candidate public.email_outbox%ROWTYPE;
  release_receipt public.mail_delivery_release_receipt%ROWTYPE;
  current_system_identifier pg_catalog.int8;
BEGIN
  IF current_user IS DISTINCT FROM 'learncoding_owner'
     OR session_user IS DISTINCT FROM 'learncoding_backup_reporter'
  THEN
    RAISE EXCEPTION 'backup status mail reporter is not authorized'
      USING ERRCODE = '42501';
  END IF;

  SELECT control.system_identifier
    INTO STRICT current_system_identifier
    FROM pg_catalog.pg_control_system() AS control;

  SELECT result.acknowledgement,
         result.authority_id,
         result.outbox_id,
         result.operation_id
    INTO result_acknowledgement,
         result_authority_id,
         result_outbox_id,
         result_operation_id
    FROM public.enqueue_backup_status_mail_authority_unreleased_0067(
      p_run_key,
      p_outcome
    ) AS result;

  IF NOT FOUND
     OR result_acknowledgement NOT IN ('queued', 'existing')
     OR result_authority_id IS NULL
     OR result_outbox_id IS NULL
     OR result_operation_id IS NULL
  THEN
    RAISE EXCEPTION 'backup status enqueue predecessor returned invalid authority'
      USING ERRCODE = '23514';
  END IF;

  SELECT outbox.*
    INTO candidate
    FROM ONLY public.email_outbox AS outbox
   WHERE outbox.id = result_outbox_id
     AND outbox.operation_id = result_operation_id
     AND outbox.template = 'backup-status'
     AND outbox.template_version = '1'
     AND outbox.idempotency_authority_version = 'event-v1-source-map'
     AND outbox.delivery_hold_version = 'task7-v1'
     AND EXISTS (
       SELECT 1
         FROM ONLY public.backup_status_mail_authority AS source
        WHERE source.id = result_authority_id
          AND source.run_key = p_run_key
          AND source.outcome = p_outcome
          AND source.outbox_id = outbox.id
          AND source.operation_id = outbox.operation_id
     )
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'backup status enqueue successor revalidation failed'
      USING ERRCODE = '23514';
  END IF;

  IF result_acknowledgement = 'queued' THEN
    IF candidate.delivery_release_insert_xid
         IS DISTINCT FROM pg_catalog.pg_current_xact_id()
       OR candidate.delivery_release_insert_system_identifier
            IS DISTINCT FROM current_system_identifier
    THEN
      RAISE EXCEPTION 'backup status release lost its insertion transaction'
        USING ERRCODE = '23514';
    END IF;

    SELECT issued.*
      INTO release_receipt
      FROM public.release_email_outbox_delivery(
        candidate.id,
        candidate.operation_id,
        candidate.idempotency_authority_sha256,
        candidate.idempotency_original_payload_sha256,
        'task7-v1'
      ) AS issued;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'backup status release receipt was not issued'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT release.*
      INTO release_receipt
      FROM ONLY public.mail_delivery_release_receipt AS release
     WHERE release.outbox_id = candidate.id
       AND release.operation_id = candidate.operation_id
       AND release.idempotency_authority_version =
             candidate.idempotency_authority_version
       AND release.idempotency_authority_sha256 =
             candidate.idempotency_authority_sha256
       AND release.idempotency_original_payload_sha256 =
             candidate.idempotency_original_payload_sha256
       AND release.release_version = candidate.delivery_hold_version
       AND release.release_receipt_sha256 =
             public.mail_delivery_release_receipt_sha256(
               candidate.id,
               candidate.operation_id,
               candidate.idempotency_authority_version,
               candidate.idempotency_authority_sha256,
               candidate.idempotency_original_payload_sha256,
               candidate.delivery_hold_version
             );

    IF NOT FOUND
       AND (
         candidate.status IS NULL
         OR candidate.status NOT IN ('sent', 'failed', 'suppressed')
       )
    THEN
      RAISE EXCEPTION 'backup status replay has no durable release receipt'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT outbox.*
    INTO candidate
    FROM ONLY public.email_outbox AS outbox
   WHERE outbox.id = result_outbox_id
     AND outbox.operation_id = result_operation_id
   FOR SHARE;

  IF NOT FOUND
     OR (
       release_receipt.outbox_id IS NOT NULL
       AND (
         candidate.delivery_release_insert_xid IS NOT NULL
         OR release_receipt.outbox_id IS DISTINCT FROM candidate.id
         OR candidate.delivery_release_insert_system_identifier IS NOT NULL
         OR release_receipt.operation_id IS DISTINCT FROM candidate.operation_id
       )
     )
  THEN
    RAISE EXCEPTION 'backup status release acknowledgement is invalid'
      USING ERRCODE = '23514';
  END IF;

  RETURN QUERY
  SELECT result_acknowledgement,
         result_authority_id,
         result_outbox_id,
         result_operation_id;
END
$function$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION
  public.enforce_email_outbox_provider_request_body_immutable()
RETURNS pg_catalog.trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
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
     OR session_user IS DISTINCT FROM 'learncoding_worker'
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
$function$;--> statement-breakpoint

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

CREATE OR REPLACE FUNCTION public.enforce_email_outbox_payload_immutable()
RETURNS pg_catalog.trigger
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog
AS $function$
DECLARE
  redaction_disposition pg_catalog.text;
  expected_email pg_catalog.text;
  expected_variables pg_catalog.jsonb;
BEGIN
  IF current_user = 'learncoding_owner'
     AND session_user = 'learncoding_ops'
  THEN
    redaction_disposition :=
      public.classify_email_outbox_quarantine_redaction_v2(
        OLD,
        pg_catalog.statement_timestamp() - interval '30 days'
      );
    expected_email := 'redacted+' || OLD.id::pg_catalog.text
      || '@invalid.local';
    expected_variables :=
      CASE WHEN redaction_disposition = 'eligible_system'
        THEN pg_catalog.jsonb_build_object(
          '_mailOperationId', OLD.operation_id::pg_catalog.text,
          '_mailRecipient', expected_email,
          '_mailProducer', OLD.variables ->> '_mailProducer',
          '_mailSourceId', OLD.variables ->> '_mailSourceId'
        ) || CASE
          WHEN OLD.variables ? '_mailAudienceId'
            THEN pg_catalog.jsonb_build_object(
              '_mailAudienceId', OLD.variables -> '_mailAudienceId'
            )
          ELSE '{}'::pg_catalog.jsonb
        END
        ELSE '{}'::pg_catalog.jsonb
      END;

    IF redaction_disposition IN (
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
       AND NEW.updated_at = pg_catalog.statement_timestamp()
       AND OLD.id IS NOT DISTINCT FROM NEW.id
       AND OLD.user_id IS NOT DISTINCT FROM NEW.user_id
       AND OLD.template IS NOT DISTINCT FROM NEW.template
       AND OLD.template_version IS NOT DISTINCT FROM NEW.template_version
       AND OLD.idempotency_key IS NOT DISTINCT FROM NEW.idempotency_key
       AND OLD.idempotency_authority_version
             IS NOT DISTINCT FROM NEW.idempotency_authority_version
       AND OLD.idempotency_authority_sha256
             IS NOT DISTINCT FROM NEW.idempotency_authority_sha256
       AND OLD.idempotency_original_payload_sha256
             IS NOT DISTINCT FROM NEW.idempotency_original_payload_sha256
       AND OLD.delivery_hold_version
             IS NOT DISTINCT FROM NEW.delivery_hold_version
       AND OLD.delivery_release_insert_xid
             IS NOT DISTINCT FROM NEW.delivery_release_insert_xid
       AND OLD.operation_id IS NOT DISTINCT FROM NEW.operation_id
       AND OLD.delivery_scope_key IS NOT DISTINCT FROM NEW.delivery_scope_key
       AND OLD.delivery_release_insert_system_identifier
             IS NOT DISTINCT FROM NEW.delivery_release_insert_system_identifier
       AND OLD.status IS NOT DISTINCT FROM NEW.status
       AND OLD.attempt_count IS NOT DISTINCT FROM NEW.attempt_count
       AND OLD.claim_token IS NOT DISTINCT FROM NEW.claim_token
       AND OLD.claim_owner IS NOT DISTINCT FROM NEW.claim_owner
       AND OLD.claim_version IS NOT DISTINCT FROM NEW.claim_version
       AND OLD.lease_expires_at IS NOT DISTINCT FROM NEW.lease_expires_at
       AND OLD.provider_call_started
             IS NOT DISTINCT FROM NEW.provider_call_started
       AND OLD.provider_request_body_sha256
             IS NOT DISTINCT FROM NEW.provider_request_body_sha256
       AND OLD.provider_request_body_length
             IS NOT DISTINCT FROM NEW.provider_request_body_length
       AND OLD.adapter IS NOT DISTINCT FROM NEW.adapter
       AND OLD.dispatch_binding_version
             IS NOT DISTINCT FROM NEW.dispatch_binding_version
       AND OLD.dispatch_binding_sha256
             IS NOT DISTINCT FROM NEW.dispatch_binding_sha256
       AND OLD.provider_correlation_version
             IS NOT DISTINCT FROM NEW.provider_correlation_version
       AND OLD.provider_evidence_version
             IS NOT DISTINCT FROM NEW.provider_evidence_version
       AND OLD.provider_evidence_sha256
             IS NOT DISTINCT FROM NEW.provider_evidence_sha256
       AND OLD.provider_message_id
             IS NOT DISTINCT FROM NEW.provider_message_id
       AND OLD.next_attempt_at IS NOT DISTINCT FROM NEW.next_attempt_at
       AND OLD.sent_at IS NOT DISTINCT FROM NEW.sent_at
       AND OLD.quarantined_at IS NOT DISTINCT FROM NEW.quarantined_at
       AND OLD.last_error_code IS NOT DISTINCT FROM NEW.last_error_code
       AND OLD.created_at IS NOT DISTINCT FROM NEW.created_at
    THEN
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
  IF OLD.idempotency_authority_version IS DISTINCT FROM
       NEW.idempotency_authority_version THEN
    RAISE EXCEPTION 'email_outbox.idempotency_authority_version is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.idempotency_authority_sha256 IS DISTINCT FROM
       NEW.idempotency_authority_sha256 THEN
    RAISE EXCEPTION 'email_outbox.idempotency_authority_sha256 is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.idempotency_original_payload_sha256 IS DISTINCT FROM
       NEW.idempotency_original_payload_sha256 THEN
    RAISE EXCEPTION
      'email_outbox.idempotency_original_payload_sha256 is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.delivery_hold_version IS DISTINCT FROM NEW.delivery_hold_version THEN
    RAISE EXCEPTION 'email_outbox.delivery_hold_version is immutable'
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

DROP TRIGGER IF EXISTS email_outbox_delivery_release_insert_xid
  ON public.email_outbox;--> statement-breakpoint
DROP TRIGGER IF EXISTS email_outbox_delivery_release_insert_xid_immutable
  ON public.email_outbox;--> statement-breakpoint
DROP TRIGGER IF EXISTS zz_email_outbox_delivery_release_identity
  ON public.email_outbox;--> statement-breakpoint
DROP TRIGGER IF EXISTS zz_email_outbox_delivery_release_insert_final
  ON public.email_outbox;--> statement-breakpoint
DROP TRIGGER IF EXISTS email_outbox_provider_request_body_immutable
  ON public.email_outbox;--> statement-breakpoint
DROP TRIGGER IF EXISTS email_outbox_delivery_hold
  ON public.email_outbox;--> statement-breakpoint
DROP TRIGGER IF EXISTS email_outbox_delivery_hold_final
  ON public.email_outbox;--> statement-breakpoint
DROP TRIGGER IF EXISTS mail_delivery_release_receipt_insert_authority
  ON public.mail_delivery_release_receipt;--> statement-breakpoint
DROP TRIGGER IF EXISTS mail_delivery_release_receipt_append_only
  ON public.mail_delivery_release_receipt;--> statement-breakpoint
DROP TRIGGER IF EXISTS mail_delivery_release_receipt_no_truncate
  ON public.mail_delivery_release_receipt;--> statement-breakpoint
DROP TRIGGER IF EXISTS email_outbox_delivery_release_commit_exact
  ON public.email_outbox;--> statement-breakpoint
DROP TRIGGER IF EXISTS email_outbox_delivery_release_delete_exact
  ON public.email_outbox;--> statement-breakpoint
DROP TRIGGER IF EXISTS mail_delivery_release_receipt_delete_exact
  ON public.mail_delivery_release_receipt;--> statement-breakpoint

CREATE TRIGGER email_outbox_delivery_release_insert_xid
BEFORE INSERT ON public.email_outbox
FOR EACH ROW
EXECUTE FUNCTION
  public.enforce_email_outbox_delivery_release_insert_xid();--> statement-breakpoint

CREATE TRIGGER email_outbox_delivery_release_insert_xid_immutable
BEFORE UPDATE OF delivery_release_insert_xid,
  delivery_release_insert_system_identifier,
  created_at
ON public.email_outbox
FOR EACH ROW
EXECUTE FUNCTION
  public.enforce_email_outbox_delivery_release_insert_xid();--> statement-breakpoint

CREATE TRIGGER zz_email_outbox_delivery_release_identity
BEFORE INSERT ON public.email_outbox
FOR EACH ROW
EXECUTE FUNCTION
  public.enforce_email_outbox_delivery_release_identity();--> statement-breakpoint
CREATE TRIGGER zz_email_outbox_delivery_release_insert_final
AFTER INSERT ON public.email_outbox
FOR EACH ROW
EXECUTE FUNCTION
  public.enforce_email_outbox_delivery_release_insert_final();--> statement-breakpoint


CREATE TRIGGER email_outbox_provider_request_body_immutable
BEFORE INSERT OR UPDATE OF
  provider_call_started,
  provider_request_body_sha256,
  provider_request_body_length
ON public.email_outbox
FOR EACH ROW
EXECUTE FUNCTION
  public.enforce_email_outbox_provider_request_body_immutable();--> statement-breakpoint

CREATE TRIGGER email_outbox_delivery_hold
BEFORE UPDATE OF
  id,
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
  provider_request_body_sha256,
  provider_request_body_length,
  next_attempt_at,
  sent_at,
  quarantined_at,
  last_error_code,
  delivery_hold_version
ON public.email_outbox
FOR EACH ROW
EXECUTE FUNCTION public.enforce_email_outbox_delivery_hold();--> statement-breakpoint

CREATE TRIGGER email_outbox_delivery_hold_final
AFTER UPDATE ON public.email_outbox
FOR EACH ROW
EXECUTE FUNCTION public.enforce_email_outbox_delivery_hold();--> statement-breakpoint

CREATE TRIGGER mail_delivery_release_receipt_insert_authority
BEFORE INSERT ON public.mail_delivery_release_receipt
FOR EACH ROW
EXECUTE FUNCTION
  public.enforce_mail_delivery_release_receipt_insert();--> statement-breakpoint

CREATE TRIGGER mail_delivery_release_receipt_append_only
BEFORE UPDATE ON public.mail_delivery_release_receipt
FOR EACH ROW
EXECUTE FUNCTION
  public.enforce_mail_delivery_release_receipt_append_only();--> statement-breakpoint

CREATE TRIGGER mail_delivery_release_receipt_no_truncate
BEFORE TRUNCATE ON public.mail_delivery_release_receipt
FOR EACH STATEMENT
EXECUTE FUNCTION
  public.enforce_mail_delivery_release_receipt_append_only();--> statement-breakpoint

CREATE CONSTRAINT TRIGGER email_outbox_delivery_release_commit_exact
AFTER INSERT ON public.email_outbox
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION
  public.enforce_email_outbox_delivery_release_commit_exact();--> statement-breakpoint

CREATE CONSTRAINT TRIGGER mail_delivery_release_receipt_delete_exact
AFTER DELETE ON public.mail_delivery_release_receipt
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION
  public.enforce_mail_delivery_release_receipt_delete_exact();--> statement-breakpoint

CREATE CONSTRAINT TRIGGER email_outbox_delivery_release_delete_exact
AFTER DELETE ON public.email_outbox
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION
  public.enforce_email_outbox_delivery_release_delete_exact();--> statement-breakpoint

ALTER TABLE ONLY public.email_outbox
  ENABLE ALWAYS TRIGGER email_outbox_dispatch_binding_guard;--> statement-breakpoint
ALTER TABLE ONLY public.email_outbox
  ENABLE ALWAYS TRIGGER email_outbox_provider_correlation_evidence_guard;--> statement-breakpoint
ALTER TABLE ONLY public.email_outbox
  ENABLE ALWAYS TRIGGER email_outbox_delivery_release_insert_xid;--> statement-breakpoint
ALTER TABLE ONLY public.email_outbox
  ENABLE ALWAYS TRIGGER email_outbox_delivery_release_insert_xid_immutable;--> statement-breakpoint
ALTER TABLE ONLY public.email_outbox
  ENABLE ALWAYS TRIGGER zz_email_outbox_delivery_release_identity;--> statement-breakpoint
ALTER TABLE ONLY public.email_outbox
  ENABLE ALWAYS TRIGGER email_outbox_provider_request_body_immutable;--> statement-breakpoint
ALTER TABLE ONLY public.email_outbox
  ENABLE ALWAYS TRIGGER zz_email_outbox_delivery_release_insert_final;--> statement-breakpoint
ALTER TABLE ONLY public.email_outbox
  ENABLE ALWAYS TRIGGER email_outbox_delivery_hold;--> statement-breakpoint
ALTER TABLE ONLY public.email_outbox
  ENABLE ALWAYS TRIGGER email_outbox_delivery_hold_final;--> statement-breakpoint
ALTER TABLE public.mail_delivery_release_receipt
  ENABLE ALWAYS TRIGGER mail_delivery_release_receipt_insert_authority;--> statement-breakpoint
ALTER TABLE public.mail_delivery_release_receipt
  ENABLE ALWAYS TRIGGER mail_delivery_release_receipt_append_only;--> statement-breakpoint
ALTER TABLE public.mail_delivery_release_receipt
  ENABLE ALWAYS TRIGGER mail_delivery_release_receipt_no_truncate;--> statement-breakpoint
ALTER TABLE ONLY public.email_outbox
  ENABLE ALWAYS TRIGGER email_outbox_delivery_release_commit_exact;--> statement-breakpoint
ALTER TABLE public.mail_delivery_release_receipt
  ENABLE ALWAYS TRIGGER mail_delivery_release_receipt_delete_exact;--> statement-breakpoint
ALTER TABLE ONLY public.email_outbox
  ENABLE ALWAYS TRIGGER email_outbox_delivery_release_delete_exact;--> statement-breakpoint

ALTER FUNCTION public.mail_delivery_release_receipt_sha256(
  pg_catalog.uuid,
  pg_catalog.uuid,
  pg_catalog.text,
  pg_catalog.text,
  pg_catalog.text,
  pg_catalog.text
) OWNER TO learncoding_owner;--> statement-breakpoint
ALTER FUNCTION public.enforce_email_outbox_delivery_release_insert_xid()
  OWNER TO learncoding_owner;--> statement-breakpoint
ALTER FUNCTION public.enforce_email_outbox_delivery_release_identity()
  OWNER TO learncoding_owner;--> statement-breakpoint
ALTER FUNCTION public.enforce_mail_delivery_release_receipt_append_only()
  OWNER TO learncoding_owner;--> statement-breakpoint
ALTER FUNCTION public.enforce_email_outbox_delivery_release_insert_final()
  OWNER TO learncoding_owner;--> statement-breakpoint
ALTER FUNCTION public.enforce_mail_delivery_release_receipt_insert()
  OWNER TO learncoding_owner;--> statement-breakpoint
ALTER FUNCTION public.release_email_outbox_delivery(
  pg_catalog.uuid,
  pg_catalog.uuid,
  pg_catalog.text,
  pg_catalog.text,
  pg_catalog.text
) OWNER TO learncoding_owner;--> statement-breakpoint
ALTER FUNCTION public.verify_email_outbox_delivery_release(
  pg_catalog.uuid,
  pg_catalog.uuid,
  pg_catalog.text,
  pg_catalog.text,
  pg_catalog.text
) OWNER TO learncoding_owner;--> statement-breakpoint
ALTER FUNCTION public.attest_email_outbox_delivery_release_lineage(
  pg_catalog.text
) OWNER TO learncoding_owner;--> statement-breakpoint
ALTER FUNCTION public.enforce_email_outbox_delivery_release_commit_exact()
  OWNER TO learncoding_owner;--> statement-breakpoint
ALTER FUNCTION public.enforce_mail_delivery_release_receipt_delete_exact()
  OWNER TO learncoding_owner;--> statement-breakpoint
ALTER FUNCTION public.enforce_email_outbox_delivery_release_delete_exact()
  OWNER TO learncoding_owner;--> statement-breakpoint
ALTER FUNCTION public.enforce_email_outbox_provider_request_body_immutable()
  OWNER TO learncoding_owner;--> statement-breakpoint
ALTER FUNCTION public.enforce_email_outbox_delivery_hold()
  OWNER TO learncoding_owner;--> statement-breakpoint
ALTER FUNCTION public.enforce_email_outbox_payload_immutable()
  OWNER TO learncoding_owner;--> statement-breakpoint
ALTER FUNCTION public.enqueue_backup_status_mail_authority_unreleased_0067(
  pg_catalog.text, pg_catalog.text
) OWNER TO learncoding_owner;--> statement-breakpoint
ALTER FUNCTION public.enqueue_backup_status_mail_authority(
  pg_catalog.text, pg_catalog.text
) OWNER TO learncoding_owner;--> statement-breakpoint
DO $scrub_guarded_delivery_acls$
DECLARE
  routine_oid pg_catalog.oid;
  routine_identity pg_catalog.text;
  relation_identity pg_catalog.text;
  target_relation_oid pg_catalog.regclass;
  acl_entry pg_catalog.record;
  column_row pg_catalog.record;
  grantee_sql pg_catalog.text;
BEGIN
  FOREACH routine_oid IN ARRAY ARRAY[
    pg_catalog.to_regprocedure(
      'public.mail_delivery_release_receipt_sha256(uuid,uuid,text,text,text,text)'
    )::pg_catalog.oid,
    pg_catalog.to_regprocedure(
      'public.enforce_email_outbox_delivery_release_insert_xid()'
    )::pg_catalog.oid,
    pg_catalog.to_regprocedure(
      'public.enforce_email_outbox_delivery_release_identity()'
    )::pg_catalog.oid,
    pg_catalog.to_regprocedure(
      'public.enforce_email_outbox_delivery_release_insert_final()'
    )::pg_catalog.oid,
    pg_catalog.to_regprocedure(
      'public.enforce_email_outbox_delivery_release_commit_exact()'
    )::pg_catalog.oid,
    pg_catalog.to_regprocedure(
      'public.enforce_mail_delivery_release_receipt_delete_exact()'
    )::pg_catalog.oid,
    pg_catalog.to_regprocedure(
      'public.enforce_email_outbox_delivery_release_delete_exact()'
    )::pg_catalog.oid,
    pg_catalog.to_regprocedure(
      'public.enforce_mail_delivery_release_receipt_append_only()'
    )::pg_catalog.oid,
    pg_catalog.to_regprocedure(
      'public.enforce_mail_delivery_release_receipt_insert()'
    )::pg_catalog.oid,
    pg_catalog.to_regprocedure(
      'public.release_email_outbox_delivery(uuid,uuid,text,text,text)'
    )::pg_catalog.oid,
    pg_catalog.to_regprocedure(
      'public.verify_email_outbox_delivery_release(uuid,uuid,text,text,text)'
    )::pg_catalog.oid,
    pg_catalog.to_regprocedure(
      'public.attest_email_outbox_delivery_release_lineage(text)'
    )::pg_catalog.oid,
    pg_catalog.to_regprocedure(
      'public.enforce_email_outbox_provider_request_body_immutable()'
    )::pg_catalog.oid,
    pg_catalog.to_regprocedure(
      'public.enforce_email_outbox_delivery_hold()'
    )::pg_catalog.oid,
    pg_catalog.to_regprocedure(
      'public.enforce_email_outbox_payload_immutable()'
    )::pg_catalog.oid,
    pg_catalog.to_regprocedure(
      'public.reject_backup_status_mail_authority_mutation()'
    )::pg_catalog.oid,
    pg_catalog.to_regprocedure(
      'public.lock_backup_status_mail_admin_authority()'
    )::pg_catalog.oid,
    pg_catalog.to_regprocedure(
      'public.enqueue_backup_status_mail_authority_unreleased_0067(text,text)'
    )::pg_catalog.oid,
    pg_catalog.to_regprocedure(
      'public.enqueue_backup_status_mail_authority(text,text)'
    )::pg_catalog.oid,
    pg_catalog.to_regprocedure(
      'public.backup_status_mail_authorized(uuid)'
    )::pg_catalog.oid
  ]
  LOOP
    IF routine_oid IS NULL THEN
      RAISE EXCEPTION '0069 ACL routine is missing'
        USING ERRCODE = '42883';
    END IF;

    routine_identity :=
      routine_oid::pg_catalog.regprocedure::pg_catalog.text;
    FOR acl_entry IN
      SELECT DISTINCT expanded.grantee
        FROM pg_catalog.pg_proc AS routine
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            routine.proacl,
            pg_catalog.acldefault('f', routine.proowner)
          )
        ) AS expanded
       WHERE routine.oid = routine_oid
       ORDER BY expanded.grantee
    LOOP
      IF acl_entry.grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',
          routine_identity
        );
      ELSE
        grantee_sql := pg_catalog.format(
          '%I',
          pg_catalog.pg_get_userbyid(acl_entry.grantee)
        );
        EXECUTE pg_catalog.format(
          'REVOKE ALL ON FUNCTION %s FROM %s CASCADE',
          routine_identity,
          grantee_sql
        );
      END IF;
    END LOOP;
  END LOOP;

  FOREACH target_relation_oid IN ARRAY ARRAY[
    'public.mail_delivery_release_receipt'::pg_catalog.regclass,
    'public.email_outbox'::pg_catalog.regclass
  ]
  LOOP
    SELECT pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
      INTO STRICT relation_identity
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
     WHERE relation.oid = target_relation_oid;

    FOR column_row IN
      SELECT attribute.attname, attribute.attacl
        FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid = target_relation_oid
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
         AND attribute.attacl IS NOT NULL
       ORDER BY attribute.attnum
    LOOP
      FOR acl_entry IN
        SELECT DISTINCT expanded.grantee
          FROM pg_catalog.aclexplode(column_row.attacl) AS expanded
         ORDER BY expanded.grantee
      LOOP
        grantee_sql := CASE
          WHEN acl_entry.grantee = 0 THEN 'PUBLIC'
          ELSE pg_catalog.format(
            '%I',
            pg_catalog.pg_get_userbyid(acl_entry.grantee)
          )
        END;
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES (%I) ON TABLE %s FROM %s CASCADE',
          column_row.attname,
          relation_identity,
          grantee_sql
        );
      END LOOP;
    END LOOP;

    FOR acl_entry IN
      SELECT DISTINCT expanded.grantee
        FROM pg_catalog.pg_class AS relation
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            relation.relacl,
            pg_catalog.acldefault('r', relation.relowner)
          )
        ) AS expanded
       WHERE relation.oid = target_relation_oid
       ORDER BY expanded.grantee
    LOOP
      grantee_sql := CASE
        WHEN acl_entry.grantee = 0 THEN 'PUBLIC'
        ELSE pg_catalog.format(
          '%I',
          pg_catalog.pg_get_userbyid(acl_entry.grantee)
        )
      END;
      EXECUTE pg_catalog.format(
        'REVOKE ALL ON TABLE %s FROM %s CASCADE',
        relation_identity,
        grantee_sql
      );
    END LOOP;
  END LOOP;
END
$scrub_guarded_delivery_acls$;--> statement-breakpoint

GRANT ALL PRIVILEGES
  ON TABLE public.mail_delivery_release_receipt
  TO learncoding_owner;--> statement-breakpoint
GRANT SELECT (
  outbox_id,
  operation_id,
  idempotency_authority_version,
  idempotency_authority_sha256,
  idempotency_original_payload_sha256,
  release_version,
  release_receipt_sha256
) ON public.mail_delivery_release_receipt
  TO learncoding_worker;--> statement-breakpoint
GRANT ALL PRIVILEGES ON TABLE public.email_outbox
  TO learncoding_owner;--> statement-breakpoint
GRANT SELECT ON TABLE public.email_outbox
  TO learncoding_app, learncoding_worker, learncoding_ops;--> statement-breakpoint
-- P3-2 residual: PostgreSQL DELETE is relation-scoped. These two runtime
-- capabilities remain until reviewed owner routines replace the current
-- account-deletion and retention call sites in a later numbered migration.
GRANT DELETE ON TABLE public.email_outbox
  TO learncoding_app, learncoding_ops;--> statement-breakpoint
GRANT INSERT (
  id,
  operation_id,
  user_id,
  delivery_scope_key,
  to_email,
  template,
  template_version,
  variables,
  idempotency_key,
  idempotency_authority_version,
  status,
  next_attempt_at
) ON public.email_outbox
  TO learncoding_app;--> statement-breakpoint
GRANT INSERT (
  operation_id,
  user_id,
  delivery_scope_key,
  to_email,
  template,
  template_version,
  variables,
  idempotency_key,
  idempotency_authority_version,
  status,
  next_attempt_at
) ON public.email_outbox
  TO learncoding_worker;--> statement-breakpoint
GRANT UPDATE (
  status,
  claim_token,
  claim_owner,
  claim_version,
  lease_expires_at,
  attempt_count,
  last_error_code,
  updated_at,
  next_attempt_at,
  provider_call_started,
  adapter,
  dispatch_binding_version,
  dispatch_binding_sha256,
  provider_correlation_version,
  provider_evidence_version,
  provider_evidence_sha256,
  provider_message_id,
  sent_at,
  quarantined_at,
  provider_request_body_sha256,
  provider_request_body_length
) ON public.email_outbox
  TO learncoding_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.release_email_outbox_delivery(
  pg_catalog.uuid,
  pg_catalog.uuid,
  pg_catalog.text,
  pg_catalog.text,
  pg_catalog.text
) TO learncoding_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.release_email_outbox_delivery(
  pg_catalog.uuid,
  pg_catalog.uuid,
  pg_catalog.text,
  pg_catalog.text,
  pg_catalog.text
) TO learncoding_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.release_email_outbox_delivery(
  pg_catalog.uuid,
  pg_catalog.uuid,
  pg_catalog.text,
  pg_catalog.text,
  pg_catalog.text
) TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.verify_email_outbox_delivery_release(
  pg_catalog.uuid,
  pg_catalog.uuid,
  pg_catalog.text,
  pg_catalog.text,
  pg_catalog.text
) TO learncoding_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.verify_email_outbox_delivery_release(
  pg_catalog.uuid,
  pg_catalog.uuid,
  pg_catalog.text,
  pg_catalog.text,
  pg_catalog.text
) TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.attest_email_outbox_delivery_release_lineage(
  pg_catalog.text
) TO learncoding_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.attest_email_outbox_delivery_release_lineage(
  pg_catalog.text
) TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  public.enforce_email_outbox_delivery_release_insert_xid()
  TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  public.enforce_email_outbox_delivery_release_identity()
  TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  public.enforce_email_outbox_delivery_release_insert_final()
  TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  public.enforce_email_outbox_delivery_release_commit_exact()
  TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  public.enforce_mail_delivery_release_receipt_delete_exact()
  TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  public.enforce_email_outbox_delivery_release_delete_exact()
  TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  public.enforce_mail_delivery_release_receipt_append_only()
  TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  public.enforce_mail_delivery_release_receipt_insert()
  TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  public.enforce_email_outbox_provider_request_body_immutable()
  TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.enforce_email_outbox_delivery_hold()
  TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.enforce_email_outbox_payload_immutable()
  TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mail_delivery_release_receipt_sha256(
  pg_catalog.uuid,
  pg_catalog.uuid,
  pg_catalog.text,
  pg_catalog.text,
  pg_catalog.text,
  pg_catalog.text
) TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mail_delivery_release_receipt_sha256(
  pg_catalog.uuid,
  pg_catalog.uuid,
  pg_catalog.text,
  pg_catalog.text,
  pg_catalog.text,
  pg_catalog.text
) TO learncoding_worker;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  public.reject_backup_status_mail_authority_mutation()
  TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  public.lock_backup_status_mail_admin_authority()
  TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  public.enqueue_backup_status_mail_authority_unreleased_0067(
    pg_catalog.text, pg_catalog.text
  ) TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.enqueue_backup_status_mail_authority(
  pg_catalog.text, pg_catalog.text
) TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.enqueue_backup_status_mail_authority(
  pg_catalog.text, pg_catalog.text
) TO learncoding_backup_reporter;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.backup_status_mail_authorized(
  pg_catalog.uuid
) TO learncoding_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.backup_status_mail_authorized(
  pg_catalog.uuid
) TO learncoding_worker;--> statement-breakpoint

DO $verify_lineage_attestor_catalog$
DECLARE
  attestor_oid pg_catalog.oid := pg_catalog.to_regprocedure(
    'public.attest_email_outbox_delivery_release_lineage(text)'
  );
  journal_oid pg_catalog.oid :=
    pg_catalog.to_regclass('drizzle.__drizzle_migrations');
  direct_acl pg_catalog.text[];
BEGIN
  IF attestor_oid IS NULL OR journal_oid IS NULL THEN
    RAISE EXCEPTION '0069 lineage attestor prerequisite is missing'
      USING ERRCODE = '23514';
  END IF;

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
    INTO direct_acl
    FROM pg_catalog.pg_proc AS routine
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        routine.proacl,
        pg_catalog.acldefault('f', routine.proowner)
      )
    ) AS access
   WHERE routine.oid = attestor_oid;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS routine
      JOIN pg_catalog.pg_language AS language
        ON language.oid = routine.prolang
     WHERE routine.oid = attestor_oid
       AND pg_catalog.pg_get_userbyid(routine.proowner) =
             'learncoding_owner'
       AND language.lanname = 'plpgsql'
       AND routine.prokind = 'f'
       AND routine.prorettype =
             'pg_catalog.record'::pg_catalog.regtype
       AND routine.proretset
       AND routine.provolatile = 's'
       AND routine.prosecdef
       AND NOT routine.proleakproof
       AND NOT routine.proisstrict
       AND routine.proparallel = 'u'
       AND routine.proconfig =
             ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
       AND routine.pronargs = 1
       AND routine.pronargdefaults = 0
       AND routine.proargdefaults IS NULL
       AND routine.proargnames = ARRAY[
             'candidate_migration_sha256',
             'phase_0066_count',
             'phase_0067_count',
             'phase_0068_count',
             'phase_0069_count',
             'candidate_hash_count',
             'lineage_window_count'
           ]::pg_catalog.text[]
       AND ARRAY(
             SELECT input_type::pg_catalog.oid
               FROM pg_catalog.unnest(routine.proargtypes) AS input_type
           )::pg_catalog.oid[] = ARRAY[
             'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid
           ]::pg_catalog.oid[]
       AND routine.proallargtypes = ARRAY[
             'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
             'pg_catalog.int4'::pg_catalog.regtype::pg_catalog.oid,
             'pg_catalog.int4'::pg_catalog.regtype::pg_catalog.oid,
             'pg_catalog.int4'::pg_catalog.regtype::pg_catalog.oid,
             'pg_catalog.int4'::pg_catalog.regtype::pg_catalog.oid,
             'pg_catalog.int4'::pg_catalog.regtype::pg_catalog.oid,
             'pg_catalog.int4'::pg_catalog.regtype::pg_catalog.oid
           ]::pg_catalog.oid[]
       AND ARRAY(
             SELECT argument_mode::pg_catalog.text
               FROM pg_catalog.unnest(routine.proargmodes) AS argument_mode
           )::pg_catalog.text[] =
             ARRAY['i', 't', 't', 't', 't', 't', 't']::pg_catalog.text[]
       AND routine.protrftypes IS NULL
       AND routine.provariadic = 0
       AND routine.prosupport = 0
       AND routine.procost = 100
       AND routine.prorows = 1000
       AND routine.probin IS NULL
       AND routine.prosqlbody IS NULL
       AND pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(routine.prosrc, 'UTF8')
             ),
             'hex'
           ) =
             '5963663f65d5be7e4e44c1ab1b1daa17a04d4bd711a9af9abc5bf2d1bb62bd91'
       AND pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(
                 pg_catalog.pg_get_functiondef(routine.oid),
                 'UTF8'
               )
             ),
             'hex'
           ) =
             '261d8137a8ad635af563b6e5478ad3ebc7579c68c5693ff87a7e2fe517e5dbbf'
       AND (
             SELECT pg_catalog.count(*)
               FROM pg_catalog.pg_proc AS overload
              WHERE overload.pronamespace =
                    'public'::pg_catalog.regnamespace
                AND overload.proname =
                    'attest_email_outbox_delivery_release_lineage'
           ) = 1
  )
     OR direct_acl IS DISTINCT FROM ARRAY[
          'learncoding_owner|learncoding_owner|execute|false',
          'learncoding_worker|learncoding_owner|execute|false'
        ]::pg_catalog.text[]
     OR NOT pg_catalog.has_function_privilege(
          'learncoding_owner', attestor_oid, 'EXECUTE'
        )
     OR NOT pg_catalog.has_function_privilege(
          'learncoding_worker', attestor_oid, 'EXECUTE'
        )
     OR pg_catalog.has_function_privilege(
          'learncoding_app', attestor_oid, 'EXECUTE'
        )
     OR pg_catalog.has_function_privilege(
          'learncoding_migrator', attestor_oid, 'EXECUTE'
        )
     OR pg_catalog.has_function_privilege(
          'learncoding_ops', attestor_oid, 'EXECUTE'
        )
     OR pg_catalog.has_function_privilege(
          'learncoding_backup_reporter', attestor_oid, 'EXECUTE'
        )
     OR pg_catalog.has_function_privilege(
          0, attestor_oid, 'EXECUTE'
        )
     OR pg_catalog.has_schema_privilege(
          'learncoding_worker', 'drizzle', 'USAGE'
        )
     OR pg_catalog.has_schema_privilege(
          'learncoding_worker', 'drizzle', 'CREATE'
        )
     OR pg_catalog.has_table_privilege(
          'learncoding_worker', journal_oid, 'SELECT'
        )
     OR pg_catalog.has_table_privilege(
          'learncoding_worker', journal_oid, 'INSERT'
        )
     OR pg_catalog.has_table_privilege(
          'learncoding_worker', journal_oid, 'UPDATE'
        )
     OR pg_catalog.has_table_privilege(
          'learncoding_worker', journal_oid, 'DELETE'
        )
  THEN
    RAISE EXCEPTION '0069 lineage attestor catalog contract is invalid'
      USING ERRCODE = '42501';
  END IF;
END
$verify_lineage_attestor_catalog$;--> statement-breakpoint

DO $verify_terminal_catalog$
DECLARE
  receipt_oid pg_catalog.oid :=
    'public.mail_delivery_release_receipt'::pg_catalog.regclass;
  receipt_row_type pg_catalog.oid;
  function_acl pg_catalog.text[];
  column_acl pg_catalog.text[];
  expected_column_acl pg_catalog.text[];
  checked_columns pg_catalog.int4 := 0;
  column_row pg_catalog.record;
  trigger_columns pg_catalog.text[];
  expected_hold_columns CONSTANT pg_catalog.text[] := ARRAY[
    'adapter',
    'attempt_count',
    'claim_owner',
    'claim_token',
    'claim_version',
    'delivery_hold_version',
    'dispatch_binding_sha256',
    'dispatch_binding_version',
    'id',
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
    'provider_request_body_length',
    'provider_request_body_sha256',
    'quarantined_at',
    'sent_at',
    'status'
  ]::pg_catalog.text[];
BEGIN
  SELECT relation.reltype
    INTO STRICT receipt_row_type
    FROM pg_catalog.pg_class AS relation
   WHERE relation.oid = receipt_oid
     AND relation.relkind = 'r'
     AND relation.relpersistence = 'p'
     AND NOT relation.relrowsecurity
     AND NOT relation.relforcerowsecurity
     AND NOT relation.relispartition
     AND relation.relpartbound IS NULL
     AND relation.reloftype = 0
     AND relation.relnatts = 8
     AND NOT relation.relhasrules
     AND NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_inherits AS inheritance
        WHERE inheritance.inhrelid = relation.oid
           OR inheritance.inhparent = relation.oid
     )
     AND NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_partitioned_table AS partitioning
        WHERE partitioning.partrelid = relation.oid
     )
     AND NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_policy AS policy
        WHERE policy.polrelid = relation.oid
     )
     AND NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_rewrite AS rewrite
        WHERE rewrite.ev_class = relation.oid
     )
     AND pg_catalog.pg_get_userbyid(relation.relowner) =
           'learncoding_owner';

  IF (
    SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = receipt_oid
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
  ) <> 8
     OR (
       SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = receipt_oid
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
          AND (
            attribute.attname,
            attribute.atttypid,
            attribute.attnotnull
          ) IN (
            ('outbox_id', 'pg_catalog.uuid'::pg_catalog.regtype, true),
            ('operation_id', 'pg_catalog.uuid'::pg_catalog.regtype, true),
            ('idempotency_authority_version',
             'pg_catalog.text'::pg_catalog.regtype, true),
            ('idempotency_authority_sha256',
             'pg_catalog.text'::pg_catalog.regtype, true),
            ('idempotency_original_payload_sha256',
             'pg_catalog.text'::pg_catalog.regtype, true),
            ('release_version', 'pg_catalog.text'::pg_catalog.regtype, true),
            ('release_receipt_sha256',
             'pg_catalog.text'::pg_catalog.regtype, true),
            ('released_at',
             'timestamp with time zone'::pg_catalog.regtype, true)
          )
          AND attribute.attnum = CASE attribute.attname
            WHEN 'outbox_id' THEN 1
            WHEN 'operation_id' THEN 2
            WHEN 'idempotency_authority_version' THEN 3
            WHEN 'idempotency_authority_sha256' THEN 4
            WHEN 'idempotency_original_payload_sha256' THEN 5
            WHEN 'release_version' THEN 6
            WHEN 'release_receipt_sha256' THEN 7
            WHEN 'released_at' THEN 8
          END
          AND attribute.atttypmod = -1
          AND attribute.attcollation = CASE
            WHEN attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
              THEN (
                SELECT type_row.typcollation
                  FROM pg_catalog.pg_type AS type_row
                 WHERE type_row.oid = 'pg_catalog.text'::pg_catalog.regtype
              )
            ELSE 0
          END
          AND attribute.atthasdef = (attribute.attname = 'released_at')
          AND attribute.attidentity = ''
          AND attribute.attgenerated = ''
          AND NOT attribute.atthasmissing
          AND attribute.attmissingval IS NULL
          AND attribute.attislocal
          AND attribute.attinhcount = 0
     ) <> 8
     OR (
       SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_attrdef AS default_row
        WHERE default_row.adrelid = receipt_oid
     ) <> 1
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_attrdef AS default_row
         JOIN pg_catalog.pg_attribute AS attribute
           ON attribute.attrelid = default_row.adrelid
          AND attribute.attnum = default_row.adnum
        WHERE default_row.adrelid = receipt_oid
          AND default_row.adnum = 8
          AND attribute.attname = 'released_at'
          AND pg_catalog.pg_get_expr(
                default_row.adbin,
                default_row.adrelid,
                false
              ) = 'statement_timestamp()'
     )
  THEN
    RAISE EXCEPTION '0069 terminal catalog contract is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF pg_catalog.current_setting('server_version_num')::pg_catalog.int4 >= 180000
     AND (
       (
         SELECT pg_catalog.count(DISTINCT constraint_row.conkey[1])
           FROM pg_catalog.pg_constraint AS constraint_row
          WHERE constraint_row.conrelid = receipt_oid
            AND constraint_row.contype = 'n'
            AND pg_catalog.cardinality(constraint_row.conkey) = 1
            AND constraint_row.conkey[1] BETWEEN 1 AND 8
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
                  (pg_catalog.to_jsonb(constraint_row)->>'conenforced')::pg_catalog.bool,
                  true
                )
       ) <> 8
       OR (
         SELECT pg_catalog.count(*)
           FROM pg_catalog.pg_constraint AS constraint_row
          WHERE constraint_row.conrelid = receipt_oid
            AND constraint_row.contype = 'n'
       ) <> 8
     )
  THEN
    RAISE EXCEPTION '0069 terminal catalog contract is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_constraint AS constraint_row
     WHERE constraint_row.conrelid = receipt_oid
       AND constraint_row.conname IN (
         'mail_delivery_release_receipt_pkey',
         'mail_delivery_release_receipt_operation_unique',
         'mail_delivery_release_receipt_digest_unique',
         'mail_delivery_release_receipt_authority_version_valid',
         'mail_delivery_release_receipt_release_version_valid',
         'mail_delivery_release_receipt_digest_valid',
         'mail_delivery_release_receipt_digest_exact',
         'mail_delivery_release_receipt_outbox_fk',
         'mail_delivery_release_receipt_idempotency_authority_fk'
       )
       AND constraint_row.convalidated
  ) <> 9
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_constraint AS foreign_key
        WHERE foreign_key.conrelid = receipt_oid
          AND foreign_key.conname =
                'mail_delivery_release_receipt_outbox_fk'
          AND foreign_key.contype = 'f'
          AND foreign_key.confrelid =
                'public.email_outbox'::pg_catalog.regclass
          AND foreign_key.convalidated
          AND NOT foreign_key.condeferrable
          AND NOT foreign_key.condeferred
          AND foreign_key.confupdtype = 'r'
          AND foreign_key.confdeltype = 'c'
          AND foreign_key.confmatchtype = 's'
          AND foreign_key.conkey = ARRAY[1, 2]::pg_catalog.int2[]
          AND foreign_key.confkey = ARRAY[1, 15]::pg_catalog.int2[]
          AND foreign_key.conindid =
                'public.email_outbox_delivery_release_parent_unique'
                  ::pg_catalog.regclass
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_constraint AS foreign_key
        WHERE foreign_key.conrelid = receipt_oid
          AND foreign_key.conname =
                'mail_delivery_release_receipt_idempotency_authority_fk'
          AND foreign_key.contype = 'f'
          AND foreign_key.confrelid =
                'public.email_outbox_idempotency_authority'::pg_catalog.regclass
          AND foreign_key.convalidated
          AND foreign_key.condeferrable
          AND foreign_key.condeferred
          AND foreign_key.confupdtype = 'r'
          AND foreign_key.confdeltype = 'r'
          AND foreign_key.confmatchtype = 's'
          AND foreign_key.conkey = ARRAY[
            (SELECT attribute.attnum
               FROM pg_catalog.pg_attribute AS attribute
              WHERE attribute.attrelid = receipt_oid
                AND attribute.attname = 'idempotency_authority_sha256'),
            (SELECT attribute.attnum
               FROM pg_catalog.pg_attribute AS attribute
              WHERE attribute.attrelid = receipt_oid
                AND attribute.attname =
                      'idempotency_original_payload_sha256')
          ]::pg_catalog.int2[]
          AND foreign_key.confkey = ARRAY[
            (SELECT attribute.attnum
               FROM pg_catalog.pg_attribute AS attribute
              WHERE attribute.attrelid = foreign_key.confrelid
                AND attribute.attname = 'idempotency_sha256'),
            (SELECT attribute.attnum
               FROM pg_catalog.pg_attribute AS attribute
              WHERE attribute.attrelid = foreign_key.confrelid
                AND attribute.attname = 'original_payload_sha256')
          ]::pg_catalog.int2[]
     )
  THEN
    RAISE EXCEPTION '0069 terminal catalog contract is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
      FROM (VALUES
        ('mail_delivery_release_receipt_authority_version_valid'::pg_catalog.text, 'c'::"char", ARRAY[3,4,5]::pg_catalog.int2[], false, false, false, '17258e40bf2d8255135dc1c7283f0afa789e55d103eaf6d64b68f9c9d92eaae4'::pg_catalog.text),
        ('mail_delivery_release_receipt_digest_exact', 'c'::"char", ARRAY[7,1,2,3,4,5,6]::pg_catalog.int2[], false, false, false, 'e15d12ca6ebec8c01ebd06c12b6644ed98aed74f2324cefe79ee284a554d6921'),
        ('mail_delivery_release_receipt_digest_unique', 'u'::"char", ARRAY[7]::pg_catalog.int2[], false, false, true, 'eac9079638de5b93751ad98ec465bcb8df523d896fec82a9a85becfb57e11e76'),
        ('mail_delivery_release_receipt_digest_valid', 'c'::"char", ARRAY[7]::pg_catalog.int2[], false, false, false, 'f52f84f271dcc21c4f726913d18aa774aafcd5b319f2b3314159c416ac1e83f0'),
        ('mail_delivery_release_receipt_idempotency_authority_fk', 'f'::"char", ARRAY[4,5]::pg_catalog.int2[], true, true, true, '69f0fb95c52b6cbc54abd0b2a4e444320899d2a0c75ee6865e4225af86de1561'),
        ('mail_delivery_release_receipt_outbox_fk', 'f'::"char", ARRAY[1,2]::pg_catalog.int2[], false, false, true, 'a404224075eb2229356afced34903caa44c5621308b335ec68fa36104584cc4b'),
        ('mail_delivery_release_receipt_operation_unique', 'u'::"char", ARRAY[2]::pg_catalog.int2[], false, false, true, 'ceda61a9e51c434fdd6437c1ee7697e3efca12a088f334255c0e095a310bc1db'),
        ('mail_delivery_release_receipt_pkey', 'p'::"char", ARRAY[1]::pg_catalog.int2[], false, false, true, '66060e6653fde114e853a55e2ffe9b592976948dc2505d2d3190652c3d76b18f'),
        ('mail_delivery_release_receipt_release_version_valid', 'c'::"char", ARRAY[6]::pg_catalog.int2[], false, false, false, '0f1cc09b02197483a4caba15e736bd7552f393d76aa66040771183230014a48a')
      ) AS expected(name, type, key_columns, is_deferrable, initially_deferred, no_inherit, definition_sha256)
      JOIN pg_catalog.pg_constraint AS constraint_row
        ON constraint_row.conrelid = receipt_oid
       AND constraint_row.conname = expected.name
     WHERE constraint_row.contype = expected.type
       AND constraint_row.conkey = expected.key_columns
       AND constraint_row.condeferrable = expected.is_deferrable
       AND constraint_row.condeferred = expected.initially_deferred
       AND constraint_row.connoinherit = expected.no_inherit
       AND constraint_row.convalidated
       AND constraint_row.conislocal
       AND constraint_row.coninhcount = 0
       AND constraint_row.conparentid = 0
       AND constraint_row.contypid = 0
       AND COALESCE(
             (pg_catalog.to_jsonb(constraint_row)->>'conenforced')::pg_catalog.bool,
             true
           )
       AND NOT COALESCE(
             (pg_catalog.to_jsonb(constraint_row)->>'conperiod')::pg_catalog.bool,
             false
           )
       AND pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(
                 pg_catalog.pg_get_constraintdef(constraint_row.oid, false),
                 'UTF8'
               )
             ),
             'hex'
           ) = expected.definition_sha256
  ) <> 9
     OR (
       SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.conrelid = receipt_oid
          AND constraint_row.contype IN ('c', 'p', 'u', 'f')
     ) <> 9
  THEN
    RAISE EXCEPTION '0069 terminal catalog contract is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint AS parent_identity
      JOIN pg_catalog.pg_class AS index_relation
        ON index_relation.oid = parent_identity.conindid
      JOIN pg_catalog.pg_index AS index_row
        ON index_row.indexrelid = index_relation.oid
      JOIN pg_catalog.pg_am AS access_method
        ON access_method.oid = index_relation.relam
     WHERE parent_identity.conrelid =
           'public.email_outbox'::pg_catalog.regclass
       AND parent_identity.connamespace = 'public'::pg_catalog.regnamespace
       AND parent_identity.conname =
             'email_outbox_delivery_release_parent_unique'
       AND parent_identity.contype = 'u'
       AND parent_identity.conkey = ARRAY[1, 15]::pg_catalog.int2[]
       AND parent_identity.conindid =
             'public.email_outbox_delivery_release_parent_unique'
               ::pg_catalog.regclass
       AND parent_identity.convalidated
       AND parent_identity.conislocal
       AND parent_identity.coninhcount = 0
       AND parent_identity.conparentid = 0
       AND parent_identity.connoinherit
       AND NOT parent_identity.condeferrable
       AND NOT parent_identity.condeferred
       AND parent_identity.contypid = 0
       AND parent_identity.confrelid = 0
       AND parent_identity.conbin IS NULL
       AND pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(
                 pg_catalog.pg_get_constraintdef(parent_identity.oid, false),
                 'UTF8'
               )
             ),
             'hex'
           ) = '2f5fa6b88fc8018a513ab5b1c5e1cf4c6f882c4463a08e04b8916f0ddd484b2b'
       AND index_relation.relkind = 'i'
       AND index_relation.relpersistence = 'p'
       AND pg_catalog.pg_get_userbyid(index_relation.relowner) =
             'learncoding_owner'
       AND access_method.amname = 'btree'
       AND index_row.indrelid = 'public.email_outbox'::pg_catalog.regclass
       AND index_row.indisunique
       AND NOT index_row.indisprimary
       AND NOT index_row.indisexclusion
       AND index_row.indimmediate
       AND index_row.indisvalid
       AND index_row.indisready
       AND index_row.indislive
       AND NOT index_row.indisclustered
       AND NOT index_row.indisreplident
       AND NOT index_row.indcheckxmin
       AND NOT index_row.indnullsnotdistinct
       AND index_row.indnkeyatts = 2
       AND index_row.indnatts = 2
       AND index_row.indkey::pg_catalog.text = '1 15'
       AND index_row.indexprs IS NULL
       AND index_row.indpred IS NULL
       AND pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(
                 pg_catalog.pg_get_indexdef(index_row.indexrelid),
                 'UTF8'
               )
             ),
             'hex'
           ) = 'b953dc6f2b39756fa0a4a2dd962d37172381802f2d4bc86fce2847de0457c7ee'
  ) THEN
    RAISE EXCEPTION '0069 terminal catalog contract is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS index_relation
      JOIN pg_catalog.pg_index AS index_row
        ON index_row.indexrelid = index_relation.oid
      JOIN pg_catalog.pg_am AS access_method
        ON access_method.oid = index_relation.relam
     WHERE index_relation.oid = pg_catalog.to_regclass(
             'public.mail_delivery_release_receipt_authority_fk_idx'
           )
       AND index_relation.relkind = 'i'
       AND index_relation.relpersistence = 'p'
       AND pg_catalog.pg_get_userbyid(index_relation.relowner) =
             'learncoding_owner'
       AND access_method.amname = 'btree'
       AND index_row.indrelid = receipt_oid
       AND NOT index_row.indisunique
       AND NOT index_row.indisprimary
       AND NOT index_row.indisexclusion
       AND index_row.indimmediate
       AND index_row.indisvalid
       AND index_row.indisready
       AND index_row.indislive
       AND NOT index_row.indisclustered
       AND NOT index_row.indisreplident
       AND NOT index_row.indcheckxmin
       AND NOT index_row.indnullsnotdistinct
       AND index_row.indnkeyatts = 2
       AND index_row.indnatts = 2
       AND index_row.indkey::pg_catalog.text = '4 5'
       AND index_row.indexprs IS NULL
       AND index_row.indpred IS NULL
       AND pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(
                 pg_catalog.pg_get_indexdef(index_row.indexrelid),
                 'UTF8'
               )
             ),
             'hex'
           ) = '42c8ad3b7f9c12b92fccf91f3161b90416e1a585195315bea449cde212c6c78e'
  ) THEN
    RAISE EXCEPTION '0069 terminal catalog contract is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    WITH expected_receipt_indexes(
      index_name,
      key_columns,
      is_unique,
      is_primary,
      is_immediate,
      exact_shape
    ) AS (
      VALUES
        (
          'mail_delivery_release_receipt_pkey'::pg_catalog.text,
          ARRAY[1]::pg_catalog.int2[], true, true, true, true
        ),
        (
          'mail_delivery_release_receipt_operation_unique',
          ARRAY[2]::pg_catalog.int2[], true, false, true, true
        ),
        (
          'mail_delivery_release_receipt_digest_unique',
          ARRAY[7]::pg_catalog.int2[], true, false, true, true
        ),
        (
          'mail_delivery_release_receipt_authority_fk_idx',
          ARRAY[4, 5]::pg_catalog.int2[], false, false, true, true
        )
    ),
    actual_receipt_indexes AS (
      SELECT
        index_relation.relname::pg_catalog.text AS index_name,
        ARRAY(
          SELECT key_column.attnum
            FROM pg_catalog.unnest(
                   index_row.indkey::pg_catalog.int2[]
                 ) WITH ORDINALITY AS key_column(attnum, ordinality)
           ORDER BY key_column.ordinality
        )::pg_catalog.int2[] AS key_columns,
        index_row.indisunique AS is_unique,
        index_row.indisprimary AS is_primary,
        index_row.indimmediate AS is_immediate,
        (
          index_relation.relkind = 'i'
          AND index_relation.relpersistence = 'p'
          AND pg_catalog.pg_get_userbyid(index_relation.relowner) =
                'learncoding_owner'
          AND index_relation.reloptions IS NULL
          AND index_relation.reltablespace = 0
          AND access_method.amname = 'btree'
          AND NOT index_row.indisexclusion
          AND index_row.indisvalid
          AND index_row.indisready
          AND index_row.indislive
          AND NOT index_row.indisclustered
          AND NOT index_row.indisreplident
          AND NOT index_row.indcheckxmin
          AND NOT index_row.indnullsnotdistinct
          AND index_row.indnkeyatts = index_row.indnatts
          AND index_row.indexprs IS NULL
          AND index_row.indpred IS NULL
          AND NOT EXISTS (
            SELECT 1
              FROM ROWS FROM (
                     pg_catalog.unnest(index_row.indkey::pg_catalog.int2[]),
                     pg_catalog.unnest(index_row.indclass::pg_catalog.oid[]),
                     pg_catalog.unnest(index_row.indcollation::pg_catalog.oid[]),
                     pg_catalog.unnest(index_row.indoption::pg_catalog.int2[])
                   ) WITH ORDINALITY AS key_column(
                     attnum, opclass_oid, collation_oid, option_bits, ordinality
                   )
              JOIN pg_catalog.pg_attribute AS attribute
                ON attribute.attrelid = index_row.indrelid
               AND attribute.attnum = key_column.attnum
             WHERE key_column.attnum <= 0
                OR key_column.option_bits <> 0
                OR key_column.collation_oid <> attribute.attcollation
                OR NOT EXISTS (
                  SELECT 1
                    FROM pg_catalog.pg_opclass AS opclass
                   WHERE opclass.oid = key_column.opclass_oid
                     AND opclass.opcmethod = index_relation.relam
                     AND opclass.opcintype = attribute.atttypid
                     AND opclass.opcdefault
                )
          )
        ) AS exact_shape
        FROM pg_catalog.pg_index AS index_row
        JOIN pg_catalog.pg_class AS index_relation
          ON index_relation.oid = index_row.indexrelid
        JOIN pg_catalog.pg_am AS access_method
          ON access_method.oid = index_relation.relam
       WHERE index_row.indrelid = receipt_oid
    ),
    receipt_index_delta AS (
      SELECT *
        FROM (
          SELECT * FROM expected_receipt_indexes
          EXCEPT ALL
          SELECT * FROM actual_receipt_indexes
        ) AS missing_receipt_indexes
      UNION ALL
      SELECT *
        FROM (
          SELECT * FROM actual_receipt_indexes
          EXCEPT ALL
          SELECT * FROM expected_receipt_indexes
        ) AS unexpected_receipt_indexes
    )
    SELECT 1 FROM receipt_index_delta
  )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.confrelid = receipt_oid
          AND constraint_row.contype = 'f'
     )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.conrelid = receipt_oid
          AND constraint_row.contype = 'x'
     )
  THEN
    RAISE EXCEPTION '0069 terminal receipt index topology is invalid'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    WITH expected_guarded_outbox_columns(
      column_name,
      attribute_number,
      type_oid,
      type_modifier,
      is_not_null,
      exact_shape
    ) AS (
      VALUES
        (
          'delivery_release_insert_xid'::pg_catalog.text,
          34::pg_catalog.int2,
          'pg_catalog.xid8'::pg_catalog.regtype::pg_catalog.oid,
          (-1)::pg_catalog.int4,
          false,
          true
        ),
        (
          'provider_request_body_sha256',
          35::pg_catalog.int2,
          'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
          (-1)::pg_catalog.int4,
          false,
          true
        ),
        (
          'provider_request_body_length',
          36::pg_catalog.int2,
          'pg_catalog.int8'::pg_catalog.regtype::pg_catalog.oid,
          (-1)::pg_catalog.int4,
          false,
          true
        ),
        (
          'delivery_release_insert_system_identifier',
          37::pg_catalog.int2,
          'pg_catalog.int8'::pg_catalog.regtype::pg_catalog.oid,
          (-1)::pg_catalog.int4,
          false,
          true
        )
    ),
    actual_guarded_outbox_columns AS (
      SELECT
        attribute.attname::pg_catalog.text AS column_name,
        attribute.attnum AS attribute_number,
        attribute.atttypid AS type_oid,
        attribute.atttypmod AS type_modifier,
        attribute.attnotnull AS is_not_null,
        (
          attribute.attcollation = type_row.typcollation
          AND attribute.attlen = type_row.typlen
          AND attribute.attbyval = type_row.typbyval
          AND attribute.attalign = type_row.typalign
          AND attribute.attstorage = type_row.typstorage
          AND attribute.attcompression = ''::"char"
          AND attribute.attstattarget IS NULL
          AND attribute.attndims = 0
          AND NOT attribute.atthasdef
          AND attribute.attidentity = ''
          AND attribute.attgenerated = ''
          AND NOT attribute.atthasmissing
          AND attribute.attmissingval IS NULL
          AND attribute.attislocal
          AND attribute.attinhcount = 0
          AND attribute.attoptions IS NULL
          AND attribute.attfdwoptions IS NULL
        ) AS exact_shape
        FROM pg_catalog.pg_attribute AS attribute
        JOIN pg_catalog.pg_type AS type_row
          ON type_row.oid = attribute.atttypid
       WHERE attribute.attrelid = 'public.email_outbox'::pg_catalog.regclass
         AND attribute.attname IN (
           'delivery_release_insert_xid',
           'delivery_release_insert_system_identifier',
           'provider_request_body_sha256',
           'provider_request_body_length'
         )
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
    ),
    guarded_outbox_column_delta AS (
      SELECT *
        FROM (
          SELECT * FROM expected_guarded_outbox_columns
          EXCEPT ALL
          SELECT * FROM actual_guarded_outbox_columns
        ) AS missing_guarded_outbox_columns
      UNION ALL
      SELECT *
        FROM (
          SELECT * FROM actual_guarded_outbox_columns
          EXCEPT ALL
          SELECT * FROM expected_guarded_outbox_columns
        ) AS unexpected_guarded_outbox_columns
    )
    SELECT 1 FROM guarded_outbox_column_delta
  )
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_attrdef AS default_row
        WHERE default_row.adrelid =
                'public.email_outbox'::pg_catalog.regclass
          AND default_row.adnum IN (34, 35, 36, 37)
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.conrelid =
                'public.email_outbox'::pg_catalog.regclass
          AND constraint_row.conname =
                'email_outbox_provider_request_body_valid'
          AND constraint_row.contype = 'c'
          AND constraint_row.convalidated
          AND NOT constraint_row.connoinherit
          AND constraint_row.conkey = ARRAY[
            (SELECT attribute.attnum
               FROM pg_catalog.pg_attribute AS attribute
              WHERE attribute.attrelid = constraint_row.conrelid
                AND attribute.attname = 'provider_request_body_sha256'),
            (SELECT attribute.attnum
               FROM pg_catalog.pg_attribute AS attribute
              WHERE attribute.attrelid = constraint_row.conrelid
                AND attribute.attname = 'provider_request_body_length')
          ]::pg_catalog.int2[]
          AND NOT constraint_row.condeferrable
          AND NOT constraint_row.condeferred
          AND constraint_row.conislocal
          AND constraint_row.coninhcount = 0
          AND constraint_row.conparentid = 0
          AND constraint_row.contypid = 0
          AND constraint_row.conindid = 0
          AND constraint_row.confrelid = 0
          AND COALESCE(
                (pg_catalog.to_jsonb(constraint_row)->>'conenforced')::pg_catalog.bool,
                true
              )
          AND pg_catalog.encode(
                pg_catalog.sha256(
                  pg_catalog.convert_to(
                    pg_catalog.pg_get_constraintdef(constraint_row.oid, false),
                    'UTF8'
                  )
                ),
                'hex'
              ) = '73b1dd1a15655f3bc1e08516f98eccf0abed9511d3b4eb7e8bc52e1860ec0afc'
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.conrelid =
                'public.email_outbox'::pg_catalog.regclass
          AND constraint_row.connamespace = 'public'::pg_catalog.regnamespace
          AND constraint_row.conname =
                'email_outbox_delivery_release_insert_identity_valid'
          AND constraint_row.contype = 'c'
          AND constraint_row.conkey = ARRAY[
            (SELECT attribute.attnum
               FROM pg_catalog.pg_attribute AS attribute
              WHERE attribute.attrelid = constraint_row.conrelid
                AND attribute.attname = 'delivery_release_insert_xid'),
            (SELECT attribute.attnum
               FROM pg_catalog.pg_attribute AS attribute
              WHERE attribute.attrelid = constraint_row.conrelid
                AND attribute.attname =
                      'delivery_release_insert_system_identifier')
          ]::pg_catalog.int2[]
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
          AND constraint_row.conbin IS NOT NULL
          AND COALESCE(
                (pg_catalog.to_jsonb(constraint_row)->>'conenforced')::pg_catalog.bool,
                true
              )
     )
     OR NOT EXISTS (
       SELECT 1
         FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.conrelid =
                'public.email_outbox'::pg_catalog.regclass
          AND constraint_row.connamespace = 'public'::pg_catalog.regnamespace
          AND constraint_row.conname = 'email_outbox_attempt_count_nonnegative'
          AND constraint_row.contype = 'c'
          AND constraint_row.conkey = ARRAY[
            (SELECT attribute.attnum
               FROM pg_catalog.pg_attribute AS attribute
              WHERE attribute.attrelid = constraint_row.conrelid
                AND attribute.attname = 'attempt_count')
          ]::pg_catalog.int2[]
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
          AND constraint_row.conbin IS NOT NULL
          AND COALESCE(
                (pg_catalog.to_jsonb(constraint_row)->>'conenforced')::pg_catalog.bool,
                true
              )
     )
     OR (
       SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.conrelid =
                'public.email_outbox'::pg_catalog.regclass
          AND constraint_row.conname IN (
            'email_outbox_delivery_release_insert_identity_valid',
            'email_outbox_attempt_count_nonnegative'
          )
     ) <> 2
  THEN
    RAISE EXCEPTION '0069 terminal catalog contract is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
      FROM (VALUES
        (
          'hash'::pg_catalog.text,
          'public.mail_delivery_release_receipt_sha256(uuid,uuid,text,text,text,text)'::pg_catalog.text,
          'sql'::pg_catalog.text,
          'i'::"char",
          true,
          true,
          's'::"char",
          false,
          'pg_catalog.text'::pg_catalog.regtype,
          ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[],
          '95169176e113b1a65fe08428dbec49e0b943b41a03867c3ed309141b3d011676'::pg_catalog.text
        ),
        (
          'marker',
          'public.enforce_email_outbox_delivery_release_insert_xid()',
          'plpgsql',
          'v'::"char",
          false,
          true,
          'u'::"char",
          false,
          'pg_catalog.trigger'::pg_catalog.regtype,
          ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[],
          'a76581c119a10ce8943cd7a60e674938d7163f8a3fe444e83f49751a7c116e46'
        ),
        (
          'identity',
          'public.enforce_email_outbox_delivery_release_identity()',
          'plpgsql',
          'v'::"char",
          false,
          true,
          'u'::"char",
          false,
          'pg_catalog.trigger'::pg_catalog.regtype,
          ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[],
          'fcceb4bb8d7e434188d871fe0eda17976c833a128e67f67f9b753393daca9c0c'
        ),
        (
          'insert_final',
          'public.enforce_email_outbox_delivery_release_insert_final()',
          'plpgsql',
          'v'::"char",
          false,
          true,
          'u'::"char",
          false,
          'pg_catalog.trigger'::pg_catalog.regtype,
          ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[],
          '42283dadeb5bed965d91ae3ff385d471295e5eb93f45b1598c9c2268cba20081'
        ),
        (
          'append_only',
          'public.enforce_mail_delivery_release_receipt_append_only()',
          'plpgsql',
          'v'::"char",
          false,
          true,
          'u'::"char",
          false,
          'pg_catalog.trigger'::pg_catalog.regtype,
          ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[],
          'ba3b8d7a3dd78f927778d41856c8c57430d188de2c3b05f8a7c3173776bed131'
        ),
        (
          'receipt_insert',
          'public.enforce_mail_delivery_release_receipt_insert()',
          'plpgsql',
          'v'::"char",
          false,
          false,
          'u'::"char",
          false,
          'pg_catalog.trigger'::pg_catalog.regtype,
          ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[],
          '5214d841459e6be0d0ab80d2a61299ddee7669d535814c287dfbc3b91c6b8225'
        ),
        (
          'issuer',
          'public.release_email_outbox_delivery(uuid,uuid,text,text,text)',
          'plpgsql',
          'v'::"char",
          false,
          true,
          'u'::"char",
          false,
          receipt_row_type,
          ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[],
          'b90df49087aa1ca69e80fc18a4963d5fc724d91db8612b338c2d2b98f2a3db0f'
        ),
        (
          'verifier',
          'public.verify_email_outbox_delivery_release(uuid,uuid,text,text,text)',
          'plpgsql',
          'v'::"char",
          false,
          true,
          'u'::"char",
          true,
          'pg_catalog.record'::pg_catalog.regtype,
          ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[],
          'b3277feeb2ed099406e17a3fe548bae580f978f5cd94a7f55f28687c81d9042c'
        ),
        (
          'commit_exact',
          'public.enforce_email_outbox_delivery_release_commit_exact()',
          'plpgsql',
          'v'::"char",
          false,
          true,
          'u'::"char",
          false,
          'pg_catalog.trigger'::pg_catalog.regtype,
          ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[],
          '27f8e42eb07338f1a543c7aec686c75d393a3fb7fb75501e576172ddf635c144'
        ),
        (
          'receipt_delete_exact',
          'public.enforce_mail_delivery_release_receipt_delete_exact()',
          'plpgsql',
          'v'::"char",
          false,
          true,
          'u'::"char",
          false,
          'pg_catalog.trigger'::pg_catalog.regtype,
          ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[],
          '39aa24c40d6dc950b15722006552a3180a80ad1345bc6450e7880a500129f0b6'
        ),
        (
          'outbox_delete_exact',
          'public.enforce_email_outbox_delivery_release_delete_exact()',
          'plpgsql',
          'v'::"char",
          false,
          true,
          'u'::"char",
          false,
          'pg_catalog.trigger'::pg_catalog.regtype,
          ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[],
          '81f7777b8fa44b02aa45f2d92a5a6219c15109a8b99eabab9ecff1190cf3e8df'
        ),
        (
          'backup_internal',
          'public.enqueue_backup_status_mail_authority_unreleased_0067(text,text)',
          'plpgsql',
          'v'::"char",
          false,
          true,
          'u'::"char",
          true,
          'pg_catalog.record'::pg_catalog.regtype,
          ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[],
          'ac406b4dff127c10f791267c1464faddbe93e8ce88faa0a52c215881ac1b7480'
        ),
        (
          'backup_wrapper',
          'public.enqueue_backup_status_mail_authority(text,text)',
          'plpgsql',
          'v'::"char",
          false,
          true,
          'u'::"char",
          true,
          'pg_catalog.record'::pg_catalog.regtype,
          ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[],
          '2cc0bf920b31af64566f1eb0352bd63f078bcccab3d064748ba5af226805c81b'
        ),
        (
          'request_guard',
          'public.enforce_email_outbox_provider_request_body_immutable()',
          'plpgsql',
          'v'::"char",
          false,
          true,
          'u'::"char",
          false,
          'pg_catalog.trigger'::pg_catalog.regtype,
          ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[],
          'a7a9a6c120a0e32410e620bb745d65b53d0d0b8429467faf74e8c62c08cc5b5f'
        ),
        (
          'hold',
          'public.enforce_email_outbox_delivery_hold()',
          'plpgsql',
          'v'::"char",
          false,
          true,
          'u'::"char",
          false,
          'pg_catalog.trigger'::pg_catalog.regtype,
          ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[],
          '7636ab37cc17692c0c31d160dc5d7f0421d6660c0da2dfb6a2d8cae4501ea4e1'
        ),
        (
          'payload',
          'public.enforce_email_outbox_payload_immutable()',
          'plpgsql',
          'v'::"char",
          false,
          false,
          'u'::"char",
          false,
          'pg_catalog.trigger'::pg_catalog.regtype,
          ARRAY['search_path=pg_catalog']::pg_catalog.text[],
          'fa3762c9faff6d8c6c3b6f1f67483ba9a888a02cfff32b29b04d6b8603e7c9fe'
        )
      ) AS expected(
        label,
        identity,
        language_name,
        volatility,
        is_strict,
        security_definer,
        parallel_mode,
        returns_set,
        return_type,
        settings,
        source_sha256
      )
      JOIN pg_catalog.pg_proc AS routine
        ON routine.oid = pg_catalog.to_regprocedure(expected.identity)
      JOIN pg_catalog.pg_language AS language
        ON language.oid = routine.prolang
     WHERE pg_catalog.pg_get_userbyid(routine.proowner) =
             'learncoding_owner'
       AND routine.prokind = 'f'
       AND routine.proretset = expected.returns_set
       AND language.lanname = expected.language_name
       AND routine.provolatile = expected.volatility
       AND routine.proisstrict = expected.is_strict
       AND routine.prosecdef = expected.security_definer
       AND routine.proparallel = expected.parallel_mode
       AND routine.prorettype = expected.return_type
       AND routine.proconfig IS NOT DISTINCT FROM expected.settings
       AND routine.pronargdefaults = 0
       AND routine.provariadic = 0
       AND NOT routine.proleakproof
       AND routine.prosupport = 0
       AND routine.probin IS NULL
       AND routine.prosqlbody IS NULL
       AND pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(routine.prosrc, 'UTF8')
             ),
             'hex'
           ) = expected.source_sha256
  ) <> 16
  THEN
    RAISE EXCEPTION '0069 terminal catalog contract is invalid'
      USING ERRCODE = '42501';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
      FROM (VALUES
        (
          'email_outbox_delivery_release_insert_xid'::pg_catalog.text,
          'public.email_outbox'::pg_catalog.regclass,
          'public.enforce_email_outbox_delivery_release_insert_xid()'::pg_catalog.text,
          7::pg_catalog.int2
        ),
        (
          'email_outbox_delivery_release_insert_xid_immutable',
          'public.email_outbox'::pg_catalog.regclass,
          'public.enforce_email_outbox_delivery_release_insert_xid()',
          19::pg_catalog.int2
        ),
        (
          'zz_email_outbox_delivery_release_identity',
          'public.email_outbox'::pg_catalog.regclass,
          'public.enforce_email_outbox_delivery_release_identity()',
          7::pg_catalog.int2
        ),
        (
          'zz_email_outbox_delivery_release_insert_final',
          'public.email_outbox'::pg_catalog.regclass,
          'public.enforce_email_outbox_delivery_release_insert_final()',
          5::pg_catalog.int2
        ),
        (
          'email_outbox_provider_request_body_immutable',
          'public.email_outbox'::pg_catalog.regclass,
          'public.enforce_email_outbox_provider_request_body_immutable()',
          23::pg_catalog.int2
        ),
        (
          'email_outbox_delivery_hold',
          'public.email_outbox'::pg_catalog.regclass,
          'public.enforce_email_outbox_delivery_hold()',
          19::pg_catalog.int2
        ),
        (
          'email_outbox_delivery_hold_final',
          'public.email_outbox'::pg_catalog.regclass,
          'public.enforce_email_outbox_delivery_hold()',
          17::pg_catalog.int2
        ),
        (
          'mail_delivery_release_receipt_append_only',
          receipt_oid,
          'public.enforce_mail_delivery_release_receipt_append_only()',
          19::pg_catalog.int2
        ),
        (
          'mail_delivery_release_receipt_insert_authority',
          receipt_oid,
          'public.enforce_mail_delivery_release_receipt_insert()',
          7::pg_catalog.int2
        ),
        (
          'mail_delivery_release_receipt_no_truncate',
          receipt_oid,
          'public.enforce_mail_delivery_release_receipt_append_only()',
          34::pg_catalog.int2
        )
      ) AS expected(trigger_name, relation_oid, function_identity, trigger_type)
      JOIN pg_catalog.pg_trigger AS trigger_row
        ON trigger_row.tgrelid = expected.relation_oid
       AND trigger_row.tgname = expected.trigger_name
     WHERE NOT trigger_row.tgisinternal
       AND trigger_row.tgconstraint = 0
       AND trigger_row.tgconstrrelid = 0
       AND trigger_row.tgqual IS NULL
       AND trigger_row.tgtype = expected.trigger_type
       AND trigger_row.tgenabled = 'A'
       AND trigger_row.tgnargs = 0
       AND pg_catalog.octet_length(trigger_row.tgargs) = 0
       AND trigger_row.tgfoid =
             pg_catalog.to_regprocedure(expected.function_identity)
  ) <> 10
     OR EXISTS (
       SELECT 1
         FROM pg_catalog.pg_trigger AS trigger_row
        WHERE NOT trigger_row.tgisinternal
          AND trigger_row.tgfoid = pg_catalog.to_regprocedure(
            'public.release_email_outbox_delivery(uuid,uuid,text,text,text)'
          )
     )
  THEN
    RAISE EXCEPTION '0069 terminal catalog contract is invalid'
      USING ERRCODE = '42501';
  END IF;

  SELECT pg_catalog.array_agg(
           attribute.attname::pg_catalog.text
           ORDER BY attribute.attname::pg_catalog.text
         )
    INTO trigger_columns
    FROM pg_catalog.pg_trigger AS trigger_row
    CROSS JOIN LATERAL pg_catalog.unnest(
      trigger_row.tgattr::pg_catalog.int2[]
    ) AS trigger_attribute(attnum)
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = trigger_row.tgrelid
     AND attribute.attnum = trigger_attribute.attnum
   WHERE trigger_row.tgrelid = 'public.email_outbox'::pg_catalog.regclass
     AND trigger_row.tgname = 'email_outbox_delivery_hold';

  IF trigger_columns IS DISTINCT FROM expected_hold_columns THEN
    RAISE EXCEPTION '0069 terminal catalog contract is invalid'
      USING ERRCODE = '42501';
  END IF;

  SELECT pg_catalog.array_agg(
           attribute.attname::pg_catalog.text
           ORDER BY attribute.attname::pg_catalog.text
         )
    INTO trigger_columns
    FROM pg_catalog.pg_trigger AS trigger_row
    CROSS JOIN LATERAL pg_catalog.unnest(
      trigger_row.tgattr::pg_catalog.int2[]
    ) AS trigger_attribute(attnum)
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = trigger_row.tgrelid
     AND attribute.attnum = trigger_attribute.attnum
   WHERE trigger_row.tgrelid = 'public.email_outbox'::pg_catalog.regclass
     AND trigger_row.tgname =
           'email_outbox_provider_request_body_immutable';

  IF trigger_columns IS DISTINCT FROM ARRAY[
       'provider_call_started',
       'provider_request_body_length',
       'provider_request_body_sha256'
     ]::pg_catalog.text[]
  THEN
    RAISE EXCEPTION '0069 terminal catalog contract is invalid'
      USING ERRCODE = '42501';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
      FROM (VALUES
        (
          'email_outbox_payload_immutable'::pg_catalog.text,
          'public.enforce_email_outbox_payload_immutable()'::pg_catalog.text,
          19::pg_catalog.int2,
          ARRAY[
            'user_id', 'to_email', 'template', 'template_version',
            'variables', 'idempotency_key', 'idempotency_authority_version',
            'idempotency_authority_sha256',
            'idempotency_original_payload_sha256',
            'delivery_hold_version', 'operation_id', 'delivery_scope_key'
          ]::pg_catalog.text[]
        ),
        (
          'email_outbox_delivery_release_insert_xid_immutable',
          'public.enforce_email_outbox_delivery_release_insert_xid()',
          19::pg_catalog.int2,
          ARRAY[
            'delivery_release_insert_xid',
            'delivery_release_insert_system_identifier', 'created_at'
          ]::pg_catalog.text[]
        ),
        (
          'email_outbox_dispatch_binding_guard',
          'public.enforce_email_outbox_dispatch_binding()',
          23::pg_catalog.int2,
          ARRAY[]::pg_catalog.text[]
        ),
        (
          'email_outbox_provider_correlation_evidence_guard',
          'public.enforce_email_outbox_provider_correlation_evidence()',
          23::pg_catalog.int2,
          ARRAY[]::pg_catalog.text[]
        )
      ) AS expected(trigger_name, function_identity, trigger_type, watched_columns)
      JOIN pg_catalog.pg_trigger AS trigger_row
        ON trigger_row.tgrelid = 'public.email_outbox'::pg_catalog.regclass
       AND trigger_row.tgname = expected.trigger_name
     WHERE NOT trigger_row.tgisinternal
       AND trigger_row.tgconstraint = 0
       AND trigger_row.tgconstrrelid = 0
       AND trigger_row.tgconstrindid = 0
       AND trigger_row.tgparentid = 0
       AND NOT trigger_row.tgdeferrable
       AND NOT trigger_row.tginitdeferred
       AND trigger_row.tgqual IS NULL
       AND trigger_row.tgoldtable IS NULL
       AND trigger_row.tgnewtable IS NULL
       AND trigger_row.tgtype = expected.trigger_type
       AND trigger_row.tgenabled = 'A'
       AND trigger_row.tgnargs = 0
       AND pg_catalog.octet_length(trigger_row.tgargs) = 0
       AND trigger_row.tgfoid =
             pg_catalog.to_regprocedure(expected.function_identity)
       AND COALESCE(
             (
               SELECT pg_catalog.array_agg(
                        attribute.attname::pg_catalog.text
                        ORDER BY watched.ordinality
                      )
                 FROM pg_catalog.unnest(
                        trigger_row.tgattr::pg_catalog.int2[]
                      ) WITH ORDINALITY AS watched(attnum, ordinality)
                 JOIN pg_catalog.pg_attribute AS attribute
                   ON attribute.attrelid = trigger_row.tgrelid
                  AND attribute.attnum = watched.attnum
             ),
             ARRAY[]::pg_catalog.text[]
           ) = expected.watched_columns
  ) <> 4
  THEN
    RAISE EXCEPTION '0069 terminal catalog contract is invalid'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    WITH expected_user_triggers(
      relation_oid,
      trigger_name,
      function_oid,
      trigger_type,
      watched_columns,
      exact_shape
    ) AS (
      VALUES
        (
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          '00_email_outbox_idempotency_persist'::pg_catalog.text,
          pg_catalog.to_regprocedure(
            'public.persist_email_outbox_idempotency_authority()'
          )::pg_catalog.oid,
          5::pg_catalog.int2,
          ARRAY[]::pg_catalog.text[],
          true
        ),
        (
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          'email_outbox_delivery_hold',
          pg_catalog.to_regprocedure(
            'public.enforce_email_outbox_delivery_hold()'
          )::pg_catalog.oid,
          19::pg_catalog.int2,
          ARRAY[
            'id', 'idempotency_authority_version',
            'idempotency_authority_sha256',
            'idempotency_original_payload_sha256', 'status',
            'attempt_count', 'claim_token', 'claim_owner', 'claim_version',
            'lease_expires_at', 'provider_call_started', 'adapter',
            'dispatch_binding_version', 'dispatch_binding_sha256',
            'provider_correlation_version', 'provider_evidence_version',
            'provider_evidence_sha256', 'provider_message_id',
            'provider_request_body_sha256', 'provider_request_body_length',
            'next_attempt_at', 'sent_at', 'quarantined_at',
            'last_error_code', 'delivery_hold_version'
          ]::pg_catalog.text[],
          true
        ),
        (
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          'email_outbox_delivery_hold_final',
          pg_catalog.to_regprocedure(
            'public.enforce_email_outbox_delivery_hold()'
          )::pg_catalog.oid,
          17::pg_catalog.int2,
          ARRAY[]::pg_catalog.text[],
          true
        ),
        (
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          'email_outbox_delivery_release_insert_xid',
          pg_catalog.to_regprocedure(
            'public.enforce_email_outbox_delivery_release_insert_xid()'
          )::pg_catalog.oid,
          7::pg_catalog.int2,
          ARRAY[]::pg_catalog.text[],
          true
        ),
        (
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          'email_outbox_delivery_release_insert_xid_immutable',
          pg_catalog.to_regprocedure(
            'public.enforce_email_outbox_delivery_release_insert_xid()'
          )::pg_catalog.oid,
          19::pg_catalog.int2,
          ARRAY[
            'delivery_release_insert_xid',
            'delivery_release_insert_system_identifier', 'created_at'
          ]::pg_catalog.text[],
          true
        ),
        (
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          'email_outbox_dispatch_binding_guard',
          pg_catalog.to_regprocedure(
            'public.enforce_email_outbox_dispatch_binding()'
          )::pg_catalog.oid,
          23::pg_catalog.int2,
          ARRAY[]::pg_catalog.text[],
          true
        ),
        (
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          'email_outbox_idempotency_claim',
          pg_catalog.to_regprocedure(
            'public.claim_email_outbox_idempotency_authority()'
          )::pg_catalog.oid,
          7::pg_catalog.int2,
          ARRAY[]::pg_catalog.text[],
          true
        ),
        (
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          'email_outbox_idempotency_metadata_immutable',
          pg_catalog.to_regprocedure(
            'public.enforce_email_outbox_idempotency_metadata_immutable()'
          )::pg_catalog.oid,
          19::pg_catalog.int2,
          ARRAY[
            'idempotency_key', 'idempotency_authority_version',
            'idempotency_authority_sha256',
            'idempotency_original_payload_sha256'
          ]::pg_catalog.text[],
          true
        ),
        (
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          'email_outbox_payload_immutable',
          pg_catalog.to_regprocedure(
            'public.enforce_email_outbox_payload_immutable()'
          )::pg_catalog.oid,
          19::pg_catalog.int2,
          ARRAY[
            'user_id', 'to_email', 'template', 'template_version',
            'variables', 'idempotency_key', 'idempotency_authority_version',
            'idempotency_authority_sha256',
            'idempotency_original_payload_sha256',
            'delivery_hold_version', 'operation_id', 'delivery_scope_key'
          ]::pg_catalog.text[],
          true
        ),
        (
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          'email_outbox_provider_correlation_evidence_guard',
          pg_catalog.to_regprocedure(
            'public.enforce_email_outbox_provider_correlation_evidence()'
          )::pg_catalog.oid,
          23::pg_catalog.int2,
          ARRAY[]::pg_catalog.text[],
          true
        ),
        (
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          'email_outbox_provider_request_body_immutable',
          pg_catalog.to_regprocedure(
            'public.enforce_email_outbox_provider_request_body_immutable()'
          )::pg_catalog.oid,
          23::pg_catalog.int2,
          ARRAY[
            'provider_call_started',
            'provider_request_body_sha256',
            'provider_request_body_length'
          ]::pg_catalog.text[],
          true
        ),
        (
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          'zz_email_outbox_delivery_release_identity',
          pg_catalog.to_regprocedure(
            'public.enforce_email_outbox_delivery_release_identity()'
          )::pg_catalog.oid,
          7::pg_catalog.int2,
          ARRAY[]::pg_catalog.text[],
          true
        ),
        (
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          'zz_email_outbox_delivery_release_insert_final',
          pg_catalog.to_regprocedure(
            'public.enforce_email_outbox_delivery_release_insert_final()'
          )::pg_catalog.oid,
          5::pg_catalog.int2,
          ARRAY[]::pg_catalog.text[],
          true
        ),
        (
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          'email_outbox_delivery_release_commit_exact',
          pg_catalog.to_regprocedure(
            'public.enforce_email_outbox_delivery_release_commit_exact()'
          )::pg_catalog.oid,
          5::pg_catalog.int2,
          ARRAY[]::pg_catalog.text[],
          false
        ),
        (
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          'email_outbox_delivery_release_delete_exact',
          pg_catalog.to_regprocedure(
            'public.enforce_email_outbox_delivery_release_delete_exact()'
          )::pg_catalog.oid,
          9::pg_catalog.int2,
          ARRAY[]::pg_catalog.text[],
          false
        ),
        (
          'public.email_outbox_idempotency_authority'
            ::pg_catalog.regclass::pg_catalog.oid,
          'email_outbox_idempotency_append_only',
          pg_catalog.to_regprocedure(
            'public.enforce_email_outbox_idempotency_append_only()'
          )::pg_catalog.oid,
          27::pg_catalog.int2,
          ARRAY[]::pg_catalog.text[],
          true
        ),
        (
          'public.email_outbox_idempotency_authority'
            ::pg_catalog.regclass::pg_catalog.oid,
          'email_outbox_idempotency_no_truncate',
          pg_catalog.to_regprocedure(
            'public.enforce_email_outbox_idempotency_append_only()'
          )::pg_catalog.oid,
          34::pg_catalog.int2,
          ARRAY[]::pg_catalog.text[],
          true
        ),
        (
          receipt_oid,
          'mail_delivery_release_receipt_append_only',
          pg_catalog.to_regprocedure(
            'public.enforce_mail_delivery_release_receipt_append_only()'
          )::pg_catalog.oid,
          19::pg_catalog.int2,
          ARRAY[]::pg_catalog.text[],
          true
        ),
        (
          receipt_oid,
          'mail_delivery_release_receipt_insert_authority',
          pg_catalog.to_regprocedure(
            'public.enforce_mail_delivery_release_receipt_insert()'
          )::pg_catalog.oid,
          7::pg_catalog.int2,
          ARRAY[]::pg_catalog.text[],
          true
        ),
        (
          receipt_oid,
          'mail_delivery_release_receipt_no_truncate',
          pg_catalog.to_regprocedure(
            'public.enforce_mail_delivery_release_receipt_append_only()'
          )::pg_catalog.oid,
          34::pg_catalog.int2,
          ARRAY[]::pg_catalog.text[],
          true
        ),
        (
          receipt_oid,
          'mail_delivery_release_receipt_delete_exact',
          pg_catalog.to_regprocedure(
            'public.enforce_mail_delivery_release_receipt_delete_exact()'
          )::pg_catalog.oid,
          9::pg_catalog.int2,
          ARRAY[]::pg_catalog.text[],
          false
        )
    ),
    actual_user_triggers AS (
      SELECT
        trigger_row.tgrelid AS relation_oid,
        trigger_row.tgname::pg_catalog.text AS trigger_name,
        trigger_row.tgfoid AS function_oid,
        trigger_row.tgtype AS trigger_type,
        COALESCE(
          (
            SELECT pg_catalog.array_agg(
                     attribute.attname::pg_catalog.text
                     ORDER BY watched.ordinality
                   )
              FROM pg_catalog.unnest(
                     trigger_row.tgattr::pg_catalog.int2[]
                   ) WITH ORDINALITY AS watched(attnum, ordinality)
              JOIN pg_catalog.pg_attribute AS attribute
                ON attribute.attrelid = trigger_row.tgrelid
               AND attribute.attnum = watched.attnum
          ),
          ARRAY[]::pg_catalog.text[]
        ) AS watched_columns,
        (
          trigger_row.tgconstraint = 0
          AND trigger_row.tgconstrrelid = 0
          AND trigger_row.tgconstrindid = 0
          AND trigger_row.tgparentid = 0
          AND NOT trigger_row.tgdeferrable
          AND NOT trigger_row.tginitdeferred
          AND trigger_row.tgqual IS NULL
          AND trigger_row.tgoldtable IS NULL
          AND trigger_row.tgnewtable IS NULL
          AND trigger_row.tgenabled = 'A'
          AND trigger_row.tgnargs = 0
          AND pg_catalog.octet_length(trigger_row.tgargs) = 0
        ) AS exact_shape
        FROM pg_catalog.pg_trigger AS trigger_row
       WHERE NOT trigger_row.tgisinternal
         AND trigger_row.tgrelid IN (
           'public.email_outbox'::pg_catalog.regclass,
           'public.email_outbox_idempotency_authority'::pg_catalog.regclass,
           receipt_oid
         )
    ),
    trigger_delta AS (
      SELECT *
        FROM (
          SELECT * FROM expected_user_triggers
          EXCEPT ALL
          SELECT * FROM actual_user_triggers
        ) AS missing_user_triggers
      UNION ALL
      SELECT *
        FROM (
          SELECT * FROM actual_user_triggers
          EXCEPT ALL
          SELECT * FROM expected_user_triggers
        ) AS unexpected_user_triggers
    )
    SELECT 1
      FROM trigger_delta
  )
  THEN
    RAISE EXCEPTION '0069 terminal catalog contract is invalid'
      USING ERRCODE = '42501';
  END IF;
  IF (
    SELECT pg_catalog.count(*)
      FROM (VALUES
        (
          'public.email_outbox'::pg_catalog.regclass,
          'email_outbox_delivery_release_commit_exact'::pg_catalog.text,
          'public.enforce_email_outbox_delivery_release_commit_exact()'::pg_catalog.text,
          5::pg_catalog.int2
        ),
        (
          'public.email_outbox'::pg_catalog.regclass,
          'email_outbox_delivery_release_delete_exact',
          'public.enforce_email_outbox_delivery_release_delete_exact()',
          9::pg_catalog.int2
        ),
        (
          receipt_oid::pg_catalog.regclass,
          'mail_delivery_release_receipt_delete_exact',
          'public.enforce_mail_delivery_release_receipt_delete_exact()',
          9::pg_catalog.int2
        )
      ) AS expected(relation_oid, trigger_name, function_identity, trigger_type)
      JOIN pg_catalog.pg_trigger AS trigger_row
        ON trigger_row.tgrelid = expected.relation_oid
       AND trigger_row.tgname = expected.trigger_name
      JOIN pg_catalog.pg_constraint AS trigger_constraint
        ON trigger_constraint.oid = trigger_row.tgconstraint
     WHERE NOT trigger_row.tgisinternal
       AND trigger_row.tgconstraint <> 0
       AND trigger_row.tgconstrrelid = 0
       AND trigger_row.tgconstrindid = 0
       AND trigger_row.tgparentid = 0
       AND trigger_row.tgdeferrable
       AND trigger_row.tginitdeferred
       AND trigger_row.tgqual IS NULL
       AND trigger_row.tgoldtable IS NULL
       AND trigger_row.tgnewtable IS NULL
       AND trigger_row.tgtype = expected.trigger_type
       AND trigger_row.tgenabled = 'A'
       AND trigger_row.tgnargs = 0
       AND pg_catalog.octet_length(trigger_row.tgargs) = 0
       AND pg_catalog.cardinality(trigger_row.tgattr::pg_catalog.int2[]) = 0
       AND trigger_row.tgfoid =
             pg_catalog.to_regprocedure(expected.function_identity)
       AND trigger_constraint.conrelid = expected.relation_oid
       AND trigger_constraint.connamespace = 'public'::pg_catalog.regnamespace
       AND trigger_constraint.conname = expected.trigger_name
       AND trigger_constraint.contype = 't'
       AND trigger_constraint.convalidated
       AND trigger_constraint.conislocal
       AND trigger_constraint.coninhcount = 0
       AND trigger_constraint.conparentid = 0
       AND trigger_constraint.condeferrable
       AND trigger_constraint.condeferred
  ) <> 3
     OR (
       SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_constraint AS trigger_constraint
        WHERE trigger_constraint.conrelid IN (
          'public.email_outbox'::pg_catalog.regclass,
          receipt_oid
        )
          AND trigger_constraint.contype = 't'
     ) <> 3
  THEN
    RAISE EXCEPTION '0069 terminal catalog contract is invalid'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    WITH expected_foreign_keys(
      constraint_name,
      child_oid,
      parent_oid,
      key_columns,
      parent_key_columns,
      backing_index_oid,
      is_deferrable,
      initially_deferred,
      update_action,
      delete_action
    ) AS (
      VALUES
        (
          'email_outbox_user_id_user_id_fk'::pg_catalog.text,
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          'public.user'::pg_catalog.regclass::pg_catalog.oid,
          ARRAY[
            (SELECT attribute.attnum
               FROM pg_catalog.pg_attribute AS attribute
              WHERE attribute.attrelid =
                    'public.email_outbox'::pg_catalog.regclass
                AND attribute.attname = 'user_id'
                AND NOT attribute.attisdropped)
          ]::pg_catalog.int2[],
          ARRAY[
            (SELECT attribute.attnum
               FROM pg_catalog.pg_attribute AS attribute
              WHERE attribute.attrelid = 'public.user'::pg_catalog.regclass
                AND attribute.attname = 'id'
                AND NOT attribute.attisdropped)
          ]::pg_catalog.int2[],
          'public.user_pkey'::pg_catalog.regclass::pg_catalog.oid,
          false,
          false,
          'a'::"char",
          'n'::"char"
        ),
        (
          'email_outbox_idempotency_authority_fk',
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          'public.email_outbox_idempotency_authority'
            ::pg_catalog.regclass::pg_catalog.oid,
          ARRAY[
            (SELECT attribute.attnum
               FROM pg_catalog.pg_attribute AS attribute
              WHERE attribute.attrelid =
                    'public.email_outbox'::pg_catalog.regclass
                AND attribute.attname = 'idempotency_authority_sha256'
                AND NOT attribute.attisdropped),
            (SELECT attribute.attnum
               FROM pg_catalog.pg_attribute AS attribute
              WHERE attribute.attrelid =
                    'public.email_outbox'::pg_catalog.regclass
                AND attribute.attname = 'idempotency_original_payload_sha256'
                AND NOT attribute.attisdropped)
          ]::pg_catalog.int2[],
          ARRAY[
            (SELECT attribute.attnum
               FROM pg_catalog.pg_attribute AS attribute
              WHERE attribute.attrelid =
                    'public.email_outbox_idempotency_authority'
                      ::pg_catalog.regclass
                AND attribute.attname = 'idempotency_sha256'
                AND NOT attribute.attisdropped),
            (SELECT attribute.attnum
               FROM pg_catalog.pg_attribute AS attribute
              WHERE attribute.attrelid =
                    'public.email_outbox_idempotency_authority'
                      ::pg_catalog.regclass
                AND attribute.attname = 'original_payload_sha256'
                AND NOT attribute.attisdropped)
          ]::pg_catalog.int2[],
          'public.email_outbox_idempotency_authority_payload_unique'
            ::pg_catalog.regclass::pg_catalog.oid,
          true,
          true,
          'r'::"char",
          'r'::"char"
        ),
        (
          'mail_delivery_release_receipt_outbox_fk',
          receipt_oid,
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          ARRAY[1, 2]::pg_catalog.int2[],
          ARRAY[1, 15]::pg_catalog.int2[],
          'public.email_outbox_delivery_release_parent_unique'
            ::pg_catalog.regclass::pg_catalog.oid,
          false,
          false,
          'r'::"char",
          'c'::"char"
        ),
        (
          'mail_delivery_release_receipt_idempotency_authority_fk',
          receipt_oid,
          'public.email_outbox_idempotency_authority'
            ::pg_catalog.regclass::pg_catalog.oid,
          ARRAY[4, 5]::pg_catalog.int2[],
          ARRAY[1, 2]::pg_catalog.int2[],
          'public.email_outbox_idempotency_authority_payload_unique'
            ::pg_catalog.regclass::pg_catalog.oid,
          true,
          true,
          'r'::"char",
          'r'::"char"
        )
    ),
    reviewed_foreign_keys AS (
      SELECT
        constraint_row.oid AS constraint_oid,
        expected.constraint_name,
        expected.child_oid,
        expected.parent_oid,
        expected.backing_index_oid
        FROM expected_foreign_keys AS expected
        JOIN pg_catalog.pg_constraint AS constraint_row
          ON constraint_row.conrelid = expected.child_oid
         AND constraint_row.conname = expected.constraint_name
       WHERE constraint_row.contype = 'f'
         AND constraint_row.confrelid = expected.parent_oid
         AND constraint_row.conkey = expected.key_columns
         AND constraint_row.confkey = expected.parent_key_columns
         AND constraint_row.conindid = expected.backing_index_oid
         AND constraint_row.condeferrable = expected.is_deferrable
         AND constraint_row.condeferred = expected.initially_deferred
         AND constraint_row.confupdtype = expected.update_action
         AND constraint_row.confdeltype = expected.delete_action
         AND constraint_row.confmatchtype = 's'
         AND constraint_row.convalidated
         AND constraint_row.conislocal
         AND constraint_row.coninhcount = 0
         AND constraint_row.conparentid = 0
         AND constraint_row.connoinherit
         AND constraint_row.contypid = 0
         AND COALESCE(
               (pg_catalog.to_jsonb(constraint_row)->>'conenforced')
                 ::pg_catalog.bool,
               true
             )
         AND NOT COALESCE(
               (pg_catalog.to_jsonb(constraint_row)->>'conperiod')
                 ::pg_catalog.bool,
               false
             )
    ),
    expected_internal_trigger_specs(
      constraint_name,
      trigger_relation_oid,
      function_oid,
      trigger_type,
      constr_relation_oid,
      trigger_deferrable,
      trigger_initially_deferred
    ) AS (
      VALUES
        (
          'email_outbox_user_id_user_id_fk'::pg_catalog.text,
          'public.user'::pg_catalog.regclass::pg_catalog.oid,
          pg_catalog.to_regprocedure(
            'pg_catalog."RI_FKey_setnull_del"()'
          )::pg_catalog.oid,
          9::pg_catalog.int2,
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          false,
          false
        ),
        (
          'email_outbox_user_id_user_id_fk',
          'public.user'::pg_catalog.regclass::pg_catalog.oid,
          pg_catalog.to_regprocedure(
            'pg_catalog."RI_FKey_noaction_upd"()'
          )::pg_catalog.oid,
          17::pg_catalog.int2,
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          false,
          false
        ),
        (
          'email_outbox_user_id_user_id_fk',
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          pg_catalog.to_regprocedure(
            'pg_catalog."RI_FKey_check_ins"()'
          )::pg_catalog.oid,
          5::pg_catalog.int2,
          'public.user'::pg_catalog.regclass::pg_catalog.oid,
          false,
          false
        ),
        (
          'email_outbox_user_id_user_id_fk',
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          pg_catalog.to_regprocedure(
            'pg_catalog."RI_FKey_check_upd"()'
          )::pg_catalog.oid,
          17::pg_catalog.int2,
          'public.user'::pg_catalog.regclass::pg_catalog.oid,
          false,
          false
        ),
        (
          'email_outbox_idempotency_authority_fk',
          'public.email_outbox_idempotency_authority'
            ::pg_catalog.regclass::pg_catalog.oid,
          pg_catalog.to_regprocedure(
            'pg_catalog."RI_FKey_restrict_del"()'
          )::pg_catalog.oid,
          9::pg_catalog.int2,
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          false,
          false
        ),
        (
          'email_outbox_idempotency_authority_fk',
          'public.email_outbox_idempotency_authority'
            ::pg_catalog.regclass::pg_catalog.oid,
          pg_catalog.to_regprocedure(
            'pg_catalog."RI_FKey_restrict_upd"()'
          )::pg_catalog.oid,
          17::pg_catalog.int2,
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          false,
          false
        ),
        (
          'email_outbox_idempotency_authority_fk',
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          pg_catalog.to_regprocedure(
            'pg_catalog."RI_FKey_check_ins"()'
          )::pg_catalog.oid,
          5::pg_catalog.int2,
          'public.email_outbox_idempotency_authority'
            ::pg_catalog.regclass::pg_catalog.oid,
          true,
          true
        ),
        (
          'email_outbox_idempotency_authority_fk',
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          pg_catalog.to_regprocedure(
            'pg_catalog."RI_FKey_check_upd"()'
          )::pg_catalog.oid,
          17::pg_catalog.int2,
          'public.email_outbox_idempotency_authority'
            ::pg_catalog.regclass::pg_catalog.oid,
          true,
          true
        ),
        (
          'mail_delivery_release_receipt_outbox_fk',
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          pg_catalog.to_regprocedure(
            'pg_catalog."RI_FKey_cascade_del"()'
          )::pg_catalog.oid,
          9::pg_catalog.int2,
          receipt_oid,
          false,
          false
        ),
        (
          'mail_delivery_release_receipt_outbox_fk',
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          pg_catalog.to_regprocedure(
            'pg_catalog."RI_FKey_restrict_upd"()'
          )::pg_catalog.oid,
          17::pg_catalog.int2,
          receipt_oid,
          false,
          false
        ),
        (
          'mail_delivery_release_receipt_outbox_fk',
          receipt_oid,
          pg_catalog.to_regprocedure(
            'pg_catalog."RI_FKey_check_ins"()'
          )::pg_catalog.oid,
          5::pg_catalog.int2,
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          false,
          false
        ),
        (
          'mail_delivery_release_receipt_outbox_fk',
          receipt_oid,
          pg_catalog.to_regprocedure(
            'pg_catalog."RI_FKey_check_upd"()'
          )::pg_catalog.oid,
          17::pg_catalog.int2,
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          false,
          false
        ),
        (
          'mail_delivery_release_receipt_idempotency_authority_fk',
          'public.email_outbox_idempotency_authority'
            ::pg_catalog.regclass::pg_catalog.oid,
          pg_catalog.to_regprocedure(
            'pg_catalog."RI_FKey_restrict_del"()'
          )::pg_catalog.oid,
          9::pg_catalog.int2,
          receipt_oid,
          false,
          false
        ),
        (
          'mail_delivery_release_receipt_idempotency_authority_fk',
          'public.email_outbox_idempotency_authority'
            ::pg_catalog.regclass::pg_catalog.oid,
          pg_catalog.to_regprocedure(
            'pg_catalog."RI_FKey_restrict_upd"()'
          )::pg_catalog.oid,
          17::pg_catalog.int2,
          receipt_oid,
          false,
          false
        ),
        (
          'mail_delivery_release_receipt_idempotency_authority_fk',
          receipt_oid,
          pg_catalog.to_regprocedure(
            'pg_catalog."RI_FKey_check_ins"()'
          )::pg_catalog.oid,
          5::pg_catalog.int2,
          'public.email_outbox_idempotency_authority'
            ::pg_catalog.regclass::pg_catalog.oid,
          true,
          true
        ),
        (
          'mail_delivery_release_receipt_idempotency_authority_fk',
          receipt_oid,
          pg_catalog.to_regprocedure(
            'pg_catalog."RI_FKey_check_upd"()'
          )::pg_catalog.oid,
          17::pg_catalog.int2,
          'public.email_outbox_idempotency_authority'
            ::pg_catalog.regclass::pg_catalog.oid,
          true,
          true
        )
    ),
    expected_internal_triggers AS (
      SELECT
        foreign_key.constraint_oid,
        expected.trigger_relation_oid,
        expected.function_oid,
        expected.trigger_type,
        expected.constr_relation_oid,
        foreign_key.backing_index_oid AS constr_index_oid,
        expected.trigger_deferrable,
        expected.trigger_initially_deferred,
        true AS exact_shape
        FROM expected_internal_trigger_specs AS expected
        JOIN reviewed_foreign_keys AS foreign_key
          ON foreign_key.constraint_name = expected.constraint_name
    ),
    actual_internal_triggers AS (
      SELECT
        foreign_key.constraint_oid,
        trigger_row.tgrelid AS trigger_relation_oid,
        trigger_row.tgfoid AS function_oid,
        trigger_row.tgtype AS trigger_type,
        trigger_row.tgconstrrelid AS constr_relation_oid,
        trigger_row.tgconstrindid AS constr_index_oid,
        trigger_row.tgdeferrable AS trigger_deferrable,
        trigger_row.tginitdeferred AS trigger_initially_deferred,
        (
          trigger_row.tgisinternal
          AND trigger_row.tgenabled = 'O'
          AND trigger_row.tgparentid = 0
          AND trigger_row.tgqual IS NULL
          AND trigger_row.tgoldtable IS NULL
          AND trigger_row.tgnewtable IS NULL
          AND trigger_row.tgnargs = 0
          AND pg_catalog.octet_length(trigger_row.tgargs) = 0
          AND pg_catalog.cardinality(
                trigger_row.tgattr::pg_catalog.int2[]
              ) = 0
          AND trigger_row.tgname ~ CASE
            WHEN trigger_row.tgrelid = foreign_key.parent_oid
              THEN '^RI_ConstraintTrigger_a_[0-9]+$'
            ELSE '^RI_ConstraintTrigger_c_[0-9]+$'
          END
        ) AS exact_shape
        FROM reviewed_foreign_keys AS foreign_key
        JOIN pg_catalog.pg_trigger AS trigger_row
          ON trigger_row.tgconstraint = foreign_key.constraint_oid
    ),
    internal_trigger_delta AS (
      SELECT *
        FROM (
          SELECT * FROM expected_internal_triggers
          EXCEPT ALL
          SELECT * FROM actual_internal_triggers
        ) AS missing_internal_triggers
      UNION ALL
      SELECT *
        FROM (
          SELECT * FROM actual_internal_triggers
          EXCEPT ALL
          SELECT * FROM expected_internal_triggers
        ) AS unexpected_internal_triggers
    ),
    internal_trigger_failure AS (
      SELECT 1
       WHERE (SELECT pg_catalog.count(*) FROM reviewed_foreign_keys) <> 4
          OR (SELECT pg_catalog.count(*)
                FROM expected_internal_triggers) <> 16
      UNION ALL
      SELECT 1 FROM internal_trigger_delta
    )
    SELECT 1 FROM internal_trigger_failure
  )
  THEN
    RAISE EXCEPTION '0069 terminal catalog contract is invalid'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    WITH expected_routine_signatures(
      routine_name,
      input_types,
      argument_names,
      all_argument_types,
      argument_modes,
      input_argument_count,
      expected_cost,
      expected_rows,
      definition_sha256,
      exact_shape
    ) AS (
      VALUES
        (
          'enforce_email_outbox_delivery_hold'::pg_catalog.text,
          ARRAY[]::pg_catalog.oid[],
          NULL::pg_catalog.text[],
          NULL::pg_catalog.oid[],
          NULL::pg_catalog.text[],
          0::pg_catalog.int2,
          100::pg_catalog.float4,
          0::pg_catalog.float4,
          '8504298d876a6fe1256f13441fe84681d0f8f47fe29cac2d42763c068e98ee7d'::pg_catalog.text,
          true
        ),
        (
          'enforce_email_outbox_delivery_release_identity',
          ARRAY[]::pg_catalog.oid[],
          NULL::pg_catalog.text[],
          NULL::pg_catalog.oid[],
          NULL::pg_catalog.text[],
          0::pg_catalog.int2,
          100::pg_catalog.float4,
          0::pg_catalog.float4,
          '150ec4c692f4f6c6247fce236d2ec7ea1b65f4b1f2864e201345867b814e9f60',
          true
        ),
        (
          'enforce_email_outbox_delivery_release_insert_xid',
          ARRAY[]::pg_catalog.oid[],
          NULL::pg_catalog.text[],
          NULL::pg_catalog.oid[],
          NULL::pg_catalog.text[],
          0::pg_catalog.int2,
          100::pg_catalog.float4,
          0::pg_catalog.float4,
          'b766a3512540a3d511a8126d87e9cbcd40847a87ea82ce27bdb2838290d97ec3',
          true
        ),
        (
          'enforce_email_outbox_payload_immutable',
          ARRAY[]::pg_catalog.oid[],
          NULL::pg_catalog.text[],
          NULL::pg_catalog.oid[],
          NULL::pg_catalog.text[],
          0::pg_catalog.int2,
          100::pg_catalog.float4,
          0::pg_catalog.float4,
          'a29a285813afa8d466198900f29680f46be35ec4c511fbcf656c78fcb9b21844',
          true
        ),
        (
          'enforce_email_outbox_provider_request_body_immutable',
          ARRAY[]::pg_catalog.oid[],
          NULL::pg_catalog.text[],
          NULL::pg_catalog.oid[],
          NULL::pg_catalog.text[],
          0::pg_catalog.int2,
          100::pg_catalog.float4,
          0::pg_catalog.float4,
          'ca95ebd3100dca787652477a7d0a3b63282a616777b44069557f503a7952a0f2',
          true
        ),
        (
          'enforce_mail_delivery_release_receipt_append_only',
          ARRAY[]::pg_catalog.oid[],
          NULL::pg_catalog.text[],
          NULL::pg_catalog.oid[],
          NULL::pg_catalog.text[],
          0::pg_catalog.int2,
          100::pg_catalog.float4,
          0::pg_catalog.float4,
          '88e9e02ba13bfd210a724e56e6216c9e0375c046b6d904307d51c50cbae4cd3a',
          true
        ),
        (
          'enforce_mail_delivery_release_receipt_insert',
          ARRAY[]::pg_catalog.oid[],
          NULL::pg_catalog.text[],
          NULL::pg_catalog.oid[],
          NULL::pg_catalog.text[],
          0::pg_catalog.int2,
          100::pg_catalog.float4,
          0::pg_catalog.float4,
          '295db3f75181663dd4491b4a84d53617179965e2a0a156995b721e53ab9c5fb1',
          true
        ),
        (
          'enqueue_backup_status_mail_authority',
          ARRAY[
            'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid
          ]::pg_catalog.oid[],
          ARRAY[
            'p_run_key', 'p_outcome', 'acknowledgement',
            'authority_id', 'outbox_id', 'operation_id'
          ]::pg_catalog.text[],
          ARRAY[
            'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid
          ]::pg_catalog.oid[],
          ARRAY['i', 'i', 't', 't', 't', 't']::pg_catalog.text[],
          2::pg_catalog.int2,
          100::pg_catalog.float4,
          1000::pg_catalog.float4,
          '6d944b1dd9ef5cfaa4371d204569f27134bf2431dd61a078b0722a3a782da6b6',
          true
        ),
        (
          'enqueue_backup_status_mail_authority_unreleased_0067',
          ARRAY[
            'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid
          ]::pg_catalog.oid[],
          ARRAY[
            'p_run_key', 'p_outcome', 'acknowledgement',
            'authority_id', 'outbox_id', 'operation_id'
          ]::pg_catalog.text[],
          ARRAY[
            'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid
          ]::pg_catalog.oid[],
          ARRAY['i', 'i', 't', 't', 't', 't']::pg_catalog.text[],
          2::pg_catalog.int2,
          100::pg_catalog.float4,
          1000::pg_catalog.float4,
          '30138cd5d305d74407dc3f294177d4ea9fa7155672d1dcf089b44fe010dd2b59',
          true
        ),
        (
          'mail_delivery_release_receipt_sha256',
          ARRAY[
            'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid
          ]::pg_catalog.oid[],
          ARRAY[
            'input_outbox_id', 'input_operation_id',
            'input_authority_version', 'input_authority_sha256',
            'input_original_payload_sha256', 'input_release_version'
          ]::pg_catalog.text[],
          NULL::pg_catalog.oid[],
          NULL::pg_catalog.text[],
          6::pg_catalog.int2,
          100::pg_catalog.float4,
          0::pg_catalog.float4,
          '63614be0762f14c3593ef05fc9f5f440a67a65bec27e703b59a18cd60273057d',
          true
        ),
        (
          'enforce_email_outbox_delivery_release_insert_final',
          ARRAY[]::pg_catalog.oid[],
          NULL::pg_catalog.text[],
          NULL::pg_catalog.oid[],
          NULL::pg_catalog.text[],
          0::pg_catalog.int2,
          100::pg_catalog.float4,
          0::pg_catalog.float4,
          NULL::pg_catalog.text,
          true
        ),
        (
          'enforce_email_outbox_delivery_release_commit_exact',
          ARRAY[]::pg_catalog.oid[],
          NULL::pg_catalog.text[],
          NULL::pg_catalog.oid[],
          NULL::pg_catalog.text[],
          0::pg_catalog.int2,
          100::pg_catalog.float4,
          0::pg_catalog.float4,
          NULL::pg_catalog.text,
          true
        ),
        (
          'enforce_mail_delivery_release_receipt_delete_exact',
          ARRAY[]::pg_catalog.oid[],
          NULL::pg_catalog.text[],
          NULL::pg_catalog.oid[],
          NULL::pg_catalog.text[],
          0::pg_catalog.int2,
          100::pg_catalog.float4,
          0::pg_catalog.float4,
          NULL::pg_catalog.text,
          true
        ),
        (
          'enforce_email_outbox_delivery_release_delete_exact',
          ARRAY[]::pg_catalog.oid[],
          NULL::pg_catalog.text[],
          NULL::pg_catalog.oid[],
          NULL::pg_catalog.text[],
          0::pg_catalog.int2,
          100::pg_catalog.float4,
          0::pg_catalog.float4,
          NULL::pg_catalog.text,
          true
        ),
        (
          'release_email_outbox_delivery',
          ARRAY[
            'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid
          ]::pg_catalog.oid[],
          ARRAY[
            'requested_outbox_id', 'requested_operation_id',
            'requested_authority_sha256',
            'requested_original_payload_sha256',
            'requested_release_version'
          ]::pg_catalog.text[],
          NULL::pg_catalog.oid[],
          NULL::pg_catalog.text[],
          5::pg_catalog.int2,
          100::pg_catalog.float4,
          0::pg_catalog.float4,
          '9516f96ef9133bdf61f6db352422d521cf4616c6bd5b365888f1c614670ed409',
          true
        ),
        (
          'verify_email_outbox_delivery_release',
          ARRAY[
            'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid
          ]::pg_catalog.oid[],
          ARRAY[
            'requested_outbox_id', 'requested_operation_id',
            'requested_authority_sha256',
            'requested_original_payload_sha256',
            'requested_release_version',
            'outbox_id', 'operation_id'
          ]::pg_catalog.text[],
          ARRAY[
            'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,
            'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid
          ]::pg_catalog.oid[],
          ARRAY[
            'i', 'i', 'i', 'i', 'i', 't', 't'
          ]::pg_catalog.text[],
          5::pg_catalog.int2,
          100::pg_catalog.float4,
          1000::pg_catalog.float4,
          '8e50e51aae34e3657a6a2d9d90fc546025512f2678b083e824a5cc0f8457ee5f',
          true
        )
    ),
    reviewed_routine_names AS (
      SELECT expected.routine_name
        FROM expected_routine_signatures AS expected
    ),
    actual_routine_signatures AS (
      SELECT
        routine.proname::pg_catalog.text AS routine_name,
        ARRAY(
          SELECT input_type::pg_catalog.oid
            FROM pg_catalog.unnest(routine.proargtypes) AS input_type
        )::pg_catalog.oid[] AS input_types,
        routine.proargnames AS argument_names,
        routine.proallargtypes AS all_argument_types,
        CASE
          WHEN routine.proargmodes IS NULL THEN NULL::pg_catalog.text[]
          ELSE ARRAY(
            SELECT mode::pg_catalog.text
              FROM pg_catalog.unnest(routine.proargmodes) AS mode
          )::pg_catalog.text[]
        END AS argument_modes,
        routine.pronargs AS input_argument_count,
        routine.procost AS expected_cost,
        routine.prorows AS expected_rows,
        CASE
          WHEN routine.proname IN (
            'enforce_email_outbox_delivery_release_insert_final',
            'enforce_email_outbox_delivery_release_commit_exact',
            'enforce_mail_delivery_release_receipt_delete_exact',
            'enforce_email_outbox_delivery_release_delete_exact'
          ) THEN NULL::pg_catalog.text
          ELSE pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(
                pg_catalog.pg_get_functiondef(routine.oid), 'UTF8'
              )
            ),
            'hex'
          )
        END AS definition_sha256,
        (
          routine.prokind = 'f'
          AND routine.pronargdefaults = 0
          AND routine.proargdefaults IS NULL
          AND routine.protrftypes IS NULL
        ) AS exact_shape
        FROM pg_catalog.pg_proc AS routine
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = routine.pronamespace
       WHERE namespace.nspname = 'public'
         AND routine.proname IN (
           SELECT reviewed.routine_name
             FROM reviewed_routine_names AS reviewed
         )
    ),
    routine_signature_delta AS (
      SELECT *
        FROM (
          SELECT * FROM expected_routine_signatures
          EXCEPT ALL
          SELECT * FROM actual_routine_signatures
        ) AS missing_routine_signatures
      UNION ALL
      SELECT *
        FROM (
          SELECT * FROM actual_routine_signatures
          EXCEPT ALL
          SELECT * FROM expected_routine_signatures
        ) AS unexpected_routine_signatures
    )
    SELECT 1 FROM routine_signature_delta
  )
  THEN
    RAISE EXCEPTION '0069 terminal catalog contract is invalid'
      USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(
           pg_catalog.array_agg(
             pg_catalog.format(
               '%s|%s|%s|%s|%s',
               reviewed.label,
               CASE WHEN access.grantee = 0
                 THEN 'PUBLIC'
                 ELSE pg_catalog.pg_get_userbyid(access.grantee)
               END,
               CASE WHEN access.grantor = 0
                 THEN 'PUBLIC'
                 ELSE pg_catalog.pg_get_userbyid(access.grantor)
               END,
               pg_catalog.lower(access.privilege_type),
               access.is_grantable::pg_catalog.text
             )
             ORDER BY reviewed.label,
                      CASE WHEN access.grantee = 0
                        THEN 'PUBLIC'
                        ELSE pg_catalog.pg_get_userbyid(access.grantee)
                      END,
                      CASE WHEN access.grantor = 0
                        THEN 'PUBLIC'
                        ELSE pg_catalog.pg_get_userbyid(access.grantor)
                      END,
                      pg_catalog.lower(access.privilege_type),
                      access.is_grantable
           ),
           ARRAY[]::pg_catalog.text[]
         )
    INTO function_acl
    FROM (VALUES
      ('append_only'::pg_catalog.text,
       pg_catalog.to_regprocedure(
         'public.enforce_mail_delivery_release_receipt_append_only()'
       )::pg_catalog.oid),
      ('backup_authorized', pg_catalog.to_regprocedure(
         'public.backup_status_mail_authorized(uuid)'
       )::pg_catalog.oid),
      ('backup_lock', pg_catalog.to_regprocedure(
         'public.lock_backup_status_mail_admin_authority()'
       )::pg_catalog.oid),
      ('backup_reject', pg_catalog.to_regprocedure(
         'public.reject_backup_status_mail_authority_mutation()'
       )::pg_catalog.oid),
      ('backup_internal', pg_catalog.to_regprocedure(
         'public.enqueue_backup_status_mail_authority_unreleased_0067(text,text)'
       )::pg_catalog.oid),
      ('backup_wrapper', pg_catalog.to_regprocedure(
         'public.enqueue_backup_status_mail_authority(text,text)'
       )::pg_catalog.oid),
      ('commit_exact', pg_catalog.to_regprocedure(
         'public.enforce_email_outbox_delivery_release_commit_exact()'
       )::pg_catalog.oid),
      ('hash', pg_catalog.to_regprocedure(
         'public.mail_delivery_release_receipt_sha256(uuid,uuid,text,text,text,text)'
       )::pg_catalog.oid),
      ('hold', pg_catalog.to_regprocedure(
         'public.enforce_email_outbox_delivery_hold()'
       )::pg_catalog.oid),
      ('issuer', pg_catalog.to_regprocedure(
         'public.release_email_outbox_delivery(uuid,uuid,text,text,text)'
       )::pg_catalog.oid),
      ('marker', pg_catalog.to_regprocedure(
         'public.enforce_email_outbox_delivery_release_insert_xid()'
       )::pg_catalog.oid),
      ('identity', pg_catalog.to_regprocedure(
         'public.enforce_email_outbox_delivery_release_identity()'
       )::pg_catalog.oid),
      ('insert_final', pg_catalog.to_regprocedure(
         'public.enforce_email_outbox_delivery_release_insert_final()'
       )::pg_catalog.oid),
      ('outbox_delete_exact', pg_catalog.to_regprocedure(
         'public.enforce_email_outbox_delivery_release_delete_exact()'
       )::pg_catalog.oid),
      ('payload', pg_catalog.to_regprocedure(
         'public.enforce_email_outbox_payload_immutable()'
       )::pg_catalog.oid),
      ('receipt_insert', pg_catalog.to_regprocedure(
         'public.enforce_mail_delivery_release_receipt_insert()'
       )::pg_catalog.oid),
      ('receipt_delete_exact', pg_catalog.to_regprocedure(
         'public.enforce_mail_delivery_release_receipt_delete_exact()'
       )::pg_catalog.oid),
      ('request_guard', pg_catalog.to_regprocedure(
         'public.enforce_email_outbox_provider_request_body_immutable()'
       )::pg_catalog.oid),
      ('verifier', pg_catalog.to_regprocedure(
         'public.verify_email_outbox_delivery_release(uuid,uuid,text,text,text)'
       )::pg_catalog.oid)
    ) AS reviewed(label, routine_oid)
    JOIN pg_catalog.pg_proc AS routine
      ON routine.oid = reviewed.routine_oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        routine.proacl,
        pg_catalog.acldefault('f', routine.proowner)
      )
    ) AS access;

  IF function_acl IS DISTINCT FROM ARRAY[
       'append_only|learncoding_owner|learncoding_owner|execute|false',
       'backup_authorized|learncoding_owner|learncoding_owner|execute|false',
       'backup_authorized|learncoding_worker|learncoding_owner|execute|false',
       'backup_internal|learncoding_owner|learncoding_owner|execute|false',
       'backup_lock|learncoding_owner|learncoding_owner|execute|false',
       'backup_reject|learncoding_owner|learncoding_owner|execute|false',
       'backup_wrapper|learncoding_backup_reporter|learncoding_owner|execute|false',
       'backup_wrapper|learncoding_owner|learncoding_owner|execute|false',
       'commit_exact|learncoding_owner|learncoding_owner|execute|false',
       'hash|learncoding_owner|learncoding_owner|execute|false',
       'hash|learncoding_worker|learncoding_owner|execute|false',
       'hold|learncoding_owner|learncoding_owner|execute|false',
       'identity|learncoding_owner|learncoding_owner|execute|false',
       'insert_final|learncoding_owner|learncoding_owner|execute|false',
       'issuer|learncoding_app|learncoding_owner|execute|false',
       'issuer|learncoding_owner|learncoding_owner|execute|false',
       'issuer|learncoding_worker|learncoding_owner|execute|false',
       'marker|learncoding_owner|learncoding_owner|execute|false',
       'outbox_delete_exact|learncoding_owner|learncoding_owner|execute|false',
       'payload|learncoding_owner|learncoding_owner|execute|false',
       'receipt_delete_exact|learncoding_owner|learncoding_owner|execute|false',
       'receipt_insert|learncoding_owner|learncoding_owner|execute|false',
       'request_guard|learncoding_owner|learncoding_owner|execute|false',
       'verifier|learncoding_app|learncoding_owner|execute|false',
       'verifier|learncoding_owner|learncoding_owner|execute|false'
     ]::pg_catalog.text[]
  THEN
    RAISE EXCEPTION '0069 terminal catalog contract is invalid'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS access
     WHERE relation.oid = receipt_oid
       AND (
         access.grantee <> relation.relowner
         OR access.grantor <> relation.relowner
         OR access.is_grantable
       )
  )
     OR NOT pg_catalog.has_table_privilege(
       'learncoding_owner', receipt_oid, 'SELECT'
     )
     OR NOT pg_catalog.has_table_privilege(
       'learncoding_owner', receipt_oid, 'INSERT'
     )
     OR NOT pg_catalog.has_table_privilege(
       'learncoding_owner', receipt_oid, 'UPDATE'
     )
     OR NOT pg_catalog.has_table_privilege(
       'learncoding_owner', receipt_oid, 'DELETE'
     )
     OR pg_catalog.has_table_privilege(
       'learncoding_app', receipt_oid, 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'learncoding_worker', receipt_oid, 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'learncoding_ops', receipt_oid, 'SELECT'
     )
  THEN
    RAISE EXCEPTION '0069 terminal catalog contract is invalid'
      USING ERRCODE = '42501';
  END IF;

  FOR column_row IN
    SELECT attribute.attname, attribute.attacl
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = receipt_oid
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
     ORDER BY attribute.attnum
  LOOP
    checked_columns := checked_columns + 1;
    SELECT COALESCE(
             pg_catalog.array_agg(
               pg_catalog.format(
                 '%s|%s|%s|%s',
                 CASE WHEN access.grantee = 0
                   THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(access.grantee)
                 END,
                 CASE WHEN access.grantor = 0
                   THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(access.grantor)
                 END,
                 pg_catalog.lower(access.privilege_type),
                 access.is_grantable::pg_catalog.text
               )
               ORDER BY
                 CASE WHEN access.grantee = 0
                   THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(access.grantee)
                 END,
                 CASE WHEN access.grantor = 0
                   THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(access.grantor)
                 END,
                 pg_catalog.lower(access.privilege_type),
                 access.is_grantable
             ),
             ARRAY[]::pg_catalog.text[]
           )
      INTO column_acl
      FROM pg_catalog.aclexplode(column_row.attacl) AS access;

    expected_column_acl := CASE
      WHEN column_row.attname IN (
        'outbox_id',
        'operation_id',
        'idempotency_authority_version',
        'idempotency_authority_sha256',
        'idempotency_original_payload_sha256',
        'release_version',
        'release_receipt_sha256'
      ) THEN ARRAY[
        'learncoding_worker|learncoding_owner|select|false'
      ]::pg_catalog.text[]
      ELSE ARRAY[]::pg_catalog.text[]
    END;

    IF column_acl IS DISTINCT FROM expected_column_acl THEN
      RAISE EXCEPTION '0069 terminal catalog contract is invalid'
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  IF checked_columns <> 8 THEN
    RAISE EXCEPTION '0069 terminal catalog contract is invalid'
      USING ERRCODE = '42703';
  END IF;

  checked_columns := 0;
  FOR column_row IN
    SELECT attribute.attname, attribute.attacl
      FROM pg_catalog.pg_attribute AS attribute
     WHERE attribute.attrelid = 'public.email_outbox'::pg_catalog.regclass
       AND attribute.attname IN (
         'delivery_release_insert_xid',
         'delivery_release_insert_system_identifier',
         'provider_request_body_sha256',
         'provider_request_body_length'
       )
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
     ORDER BY attribute.attname
  LOOP
    checked_columns := checked_columns + 1;
    SELECT COALESCE(
             pg_catalog.array_agg(
               pg_catalog.format(
                 '%s|%s|%s|%s',
                 CASE WHEN access.grantee = 0
                   THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(access.grantee)
                 END,
                 CASE WHEN access.grantor = 0
                   THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(access.grantor)
                 END,
                 pg_catalog.lower(access.privilege_type),
                 access.is_grantable::pg_catalog.text
               )
               ORDER BY
                 CASE WHEN access.grantee = 0
                   THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(access.grantee)
                 END,
                 CASE WHEN access.grantor = 0
                   THEN 'PUBLIC'
                   ELSE pg_catalog.pg_get_userbyid(access.grantor)
                 END,
                 pg_catalog.lower(access.privilege_type),
                 access.is_grantable
             ),
             ARRAY[]::pg_catalog.text[]
           )
      INTO column_acl
      FROM pg_catalog.aclexplode(column_row.attacl) AS access;

    expected_column_acl := CASE
      WHEN column_row.attname IN (
        'provider_request_body_sha256',
        'provider_request_body_length'
      ) THEN ARRAY[
        'learncoding_worker|learncoding_owner|update|false'
      ]::pg_catalog.text[]
      ELSE ARRAY[]::pg_catalog.text[]
    END;

    IF column_acl IS DISTINCT FROM expected_column_acl THEN
      RAISE EXCEPTION '0069 terminal catalog contract is invalid'
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  IF checked_columns <> 4
     OR pg_catalog.pg_has_role(
       'learncoding_app', 'learncoding_owner', 'MEMBER'
     )
     OR pg_catalog.pg_has_role(
       'learncoding_worker', 'learncoding_owner', 'MEMBER'
     )
     OR pg_catalog.pg_has_role(
       'learncoding_ops',
       'learncoding_owner',
       'MEMBER'
     )
     OR pg_catalog.pg_has_role(
       'learncoding_backup_reporter',
       'learncoding_owner',
       'MEMBER'
     )
     OR pg_catalog.has_function_privilege(
       0,
       pg_catalog.to_regprocedure(
         'public.release_email_outbox_delivery(uuid,uuid,text,text,text)'
       ),
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'learncoding_ops',
       'public.release_email_outbox_delivery(uuid,uuid,text,text,text)',
       'EXECUTE'
     )
  THEN
    RAISE EXCEPTION '0069 terminal catalog contract is invalid'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    WITH expected_inherited_routines(
      identity,
      routine_name,
      source_sha256,
      definition_sha256,
      ops_execute
    ) AS (
      VALUES
        (
          'public.enforce_email_outbox_dispatch_binding()'::pg_catalog.text,
          'enforce_email_outbox_dispatch_binding'::pg_catalog.text,
          'e03d2be2455d53f9ddd0c0b7a8029efd07186a4d6804b86c2206b29031da7fdf'::pg_catalog.text,
          'b3ba15cae78eaf8e3535b28c0764e9715683e15ab85b0814089e3e54715f4676'::pg_catalog.text,
          false
        ),
        (
          'public.enforce_email_outbox_provider_correlation_evidence()',
          'enforce_email_outbox_provider_correlation_evidence',
          '62ff4885055979fb7eaf0fda3ae8170a14a430cb69d8f310e6aba742cf700e1a',
          'afaab6796f97aa0294ff5a761679895f9ccfb78fea21e0be362979c5c4e5ab11',
          false
        ),
        (
          'public.enforce_email_outbox_idempotency_metadata_immutable()',
          'enforce_email_outbox_idempotency_metadata_immutable',
          '9e953537c1fc8f4cdceda981731aa20c9412dbd46cefdcc71e433de3eced76c3',
          'a26ccda1f7f4d623c7ea2b1611ff9f5c424cee386f79a7a8ffbf2a58c51ce2e9',
          false
        ),
        (
          'public.enforce_email_outbox_idempotency_append_only()',
          'enforce_email_outbox_idempotency_append_only',
          '164b71af1bca387a599b64246851b7ba3e66c8a9557a60581dec54eb4d757370',
          '2ae733ebe79975ce70fa9427ccb92295ecf8acad75797e8541bbb15bd9318790',
          false
        ),
        (
          'public.email_outbox_idempotency_coverage_authority(uuid[])',
          'email_outbox_idempotency_coverage_authority',
          '417c8583bb2509354b89e63317718a14cd0afbf08e62d534cd64341acc290e48',
          '2efbc33e8ee9dd33402f11682697f4e522cd9e7e3c70c8bf820f533b37aec1ac',
          true
        ),
        (
          'public.classify_email_outbox_quarantine_redaction_v2(public.email_outbox,timestamp with time zone)',
          'classify_email_outbox_quarantine_redaction_v2',
          '056ab5e7fdd72b643ba48d9fe6caf0e1c678f4c7e8afbdf8edf0c844e02f0424',
          '8331736656001b0bb0fa5d303667353846ea4ff39c3f5aeba71979141f2dc612',
          false
        ),
        (
          'public.redact_quarantined_email_outbox_authority_v2(timestamp with time zone,integer)',
          'redact_quarantined_email_outbox_authority_v2',
          '5a10a9df1684cb1355941c456eb03e46309eb12fa4dcdcda4ecf5f942241ae7b',
          '29ee2d3b4bf45322c9c68a3bc612084a460bfca3e54e7c2c044081d195fbe2b7',
          true
        ),
        (
          'public.claim_email_outbox_idempotency_authority()',
          'claim_email_outbox_idempotency_authority',
          '9b0b6468cb0aad890bd78ecfa68bdab9f476d5f93a9841d515e0cea019926499',
          'c5e22b06c168cb1aa4099f3b3c66cc959b4a0b116313d2bce8fa3a3d9d77197b',
          false
        ),
        (
          'public.persist_email_outbox_idempotency_authority()',
          'persist_email_outbox_idempotency_authority',
          '43e5df19b455c36648574e1d7c33c10cb959fc3bddd83e6ed67035031f246cbd',
          '4890f478c8d14811e7f6829a3a4977e0da3924c8e8c84b8ca89b64496ac40f53',
          false
        )
    ),
    actual_inherited_routines AS (
      SELECT
        expected.*,
        routine.oid AS routine_oid,
        pg_catalog.pg_get_userbyid(routine.proowner) AS owner_name,
        language.lanname AS language_name,
        routine.prokind,
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
        CASE
          WHEN routine.oid IS NULL THEN NULL
          ELSE COALESCE(
            (
              SELECT pg_catalog.array_agg(
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
                         access.is_grantable
                       )
                       ORDER BY pg_catalog.concat_ws(
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
                         access.is_grantable
                       )
                     )
                FROM pg_catalog.aclexplode(
                       COALESCE(
                         routine.proacl,
                         pg_catalog.acldefault('f', routine.proowner)
                       )
                     ) AS access
            ),
            ARRAY[]::pg_catalog.text[]
          )
        END AS execute_acl,
        (
          SELECT pg_catalog.count(*)
            FROM pg_catalog.pg_proc AS overload
           WHERE overload.pronamespace = 'public'::pg_catalog.regnamespace
             AND overload.proname = expected.routine_name
        ) AS overload_count
        FROM expected_inherited_routines AS expected
        LEFT JOIN pg_catalog.pg_proc AS routine
          ON routine.oid = pg_catalog.to_regprocedure(expected.identity)
        LEFT JOIN pg_catalog.pg_language AS language
          ON language.oid = routine.prolang
    )
    SELECT 1
      FROM actual_inherited_routines AS actual
     WHERE actual.routine_oid IS NULL
        OR actual.owner_name IS DISTINCT FROM 'learncoding_owner'
        OR actual.language_name IS DISTINCT FROM 'plpgsql'
        OR actual.prokind IS DISTINCT FROM 'f'
        OR actual.actual_source_sha256 IS DISTINCT FROM actual.source_sha256
        OR actual.actual_definition_sha256 IS DISTINCT FROM
             actual.definition_sha256
        OR actual.overload_count <> 1
        OR actual.execute_acl IS DISTINCT FROM CASE
          WHEN actual.ops_execute THEN ARRAY[
            'learncoding_ops|learncoding_owner|execute|f',
            'learncoding_owner|learncoding_owner|execute|f'
          ]::pg_catalog.text[]
          ELSE ARRAY[
            'learncoding_owner|learncoding_owner|execute|f'
          ]::pg_catalog.text[]
        END
  )
  THEN
    RAISE EXCEPTION '0069 inherited mail authority routines are invalid'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    WITH expected_digest_helpers(
      identity,
      routine_name,
      source_sha256,
      definition_sha256
    ) AS (
      VALUES
        (
          'public.email_outbox_original_payload_sha256(text,text,text,text,jsonb)'::pg_catalog.text,
          'email_outbox_original_payload_sha256'::pg_catalog.text,
          '6b7100af8bd25093520317e67d5a06b40848b192ca94eb4b6c63ef48adcf89a2'::pg_catalog.text,
          CASE
            pg_catalog.current_setting('server_version_num')::pg_catalog.int4
              / 10000
            WHEN 17 THEN
              '35691db9ef3153adf2e19ebae539341797f7b4fd2a27aec1db215b9533636ed8'
            WHEN 18 THEN
              '365bd47aab3ce58ca2b894c7eb77ed12cb759fc3683599ef5ae987e4414f1d3c'
            ELSE NULL
          END
        ),
        (
          'public.email_outbox_event_sha256(text,text,text)',
          'email_outbox_event_sha256',
          'dbb1e105e567de47875c1bdd433b61cc78745fc0bc7953daa68b6f3f2bf83315',
          '02d83d883c8f4c0b4fc22c460353834d27a67becdd96d81cee8b74609521f334'
        )
    ),
    actual_digest_helpers AS (
      SELECT
        expected.*,
        routine.oid AS routine_oid,
        pg_catalog.pg_get_userbyid(routine.proowner) AS owner_name,
        language.lanname AS language_name,
        routine.prokind,
        routine.prorettype,
        routine.proretset,
        routine.provolatile,
        routine.prosecdef,
        routine.proleakproof,
        routine.proisstrict,
        routine.proparallel,
        routine.proconfig,
        routine.pronargdefaults,
        routine.proargdefaults,
        routine.proallargtypes,
        routine.proargmodes,
        routine.protrftypes,
        routine.provariadic,
        routine.prosupport,
        routine.procost,
        routine.prorows,
        routine.probin,
        routine.prosqlbody,
        routine.proacl,
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
        (
          SELECT pg_catalog.count(*)
            FROM pg_catalog.pg_proc AS overload
           WHERE overload.pronamespace = 'public'::pg_catalog.regnamespace
             AND overload.proname = expected.routine_name
        ) AS overload_count
        FROM expected_digest_helpers AS expected
        LEFT JOIN pg_catalog.pg_proc AS routine
          ON routine.oid = pg_catalog.to_regprocedure(expected.identity)
        LEFT JOIN pg_catalog.pg_language AS language
          ON language.oid = routine.prolang
    )
    SELECT 1
      FROM actual_digest_helpers AS actual
     WHERE actual.routine_oid IS NULL
        OR actual.owner_name IS DISTINCT FROM 'learncoding_owner'
        OR actual.language_name IS DISTINCT FROM 'sql'
        OR actual.prokind IS DISTINCT FROM 'f'
        OR actual.prorettype IS DISTINCT FROM
             'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid
        OR actual.proretset
        OR actual.provolatile IS DISTINCT FROM 'i'
        OR NOT actual.prosecdef
        OR actual.proleakproof
        OR actual.proisstrict
        OR actual.proparallel IS DISTINCT FROM 'u'
        OR actual.proconfig IS DISTINCT FROM
             ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
        OR actual.pronargdefaults <> 0
        OR actual.proargdefaults IS NOT NULL
        OR actual.proallargtypes IS NOT NULL
        OR actual.proargmodes IS NOT NULL
        OR actual.protrftypes IS NOT NULL
        OR actual.provariadic <> 0
        OR actual.prosupport <> 0
        OR actual.procost <> 100
        OR actual.prorows <> 0
        OR actual.probin IS NOT NULL
        OR actual.prosqlbody IS NOT NULL
        OR actual.proacl IS DISTINCT FROM ARRAY[
             'learncoding_owner=X/learncoding_owner'::pg_catalog.aclitem
           ]::pg_catalog.aclitem[]
        OR actual.actual_source_sha256 IS DISTINCT FROM actual.source_sha256
        OR actual.actual_definition_sha256 IS DISTINCT FROM
             actual.definition_sha256
        OR actual.overload_count <> 1
  )
  THEN
    RAISE EXCEPTION '0069 inherited mail digest helpers are invalid'
      USING ERRCODE = '42501';
  END IF;
  IF EXISTS (
    WITH managed_principals(principal_name, principal_oid) AS (
      VALUES
        ('PUBLIC'::pg_catalog.text, 0::pg_catalog.oid),
        ('learncoding_owner',
         pg_catalog.to_regrole('learncoding_owner')::pg_catalog.oid),
        ('learncoding_migrator',
         pg_catalog.to_regrole('learncoding_migrator')::pg_catalog.oid),
        ('learncoding_app',
         pg_catalog.to_regrole('learncoding_app')::pg_catalog.oid),
        ('learncoding_worker',
         pg_catalog.to_regrole('learncoding_worker')::pg_catalog.oid),
        ('learncoding_ops',
         pg_catalog.to_regrole('learncoding_ops')::pg_catalog.oid),
        ('learncoding_backup_reporter',
         pg_catalog.to_regrole('learncoding_backup_reporter')::pg_catalog.oid)
    ),
    protected_relations(relation_label, relation_oid) AS (
      VALUES
        (
          'outbox'::pg_catalog.text,
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid
        ),
        ('receipt', receipt_oid),
        (
          'replay_authority',
          'public.email_outbox_idempotency_authority'
            ::pg_catalog.regclass::pg_catalog.oid
        ),
        (
          'backup_authority',
          'public.backup_status_mail_authority'
            ::pg_catalog.regclass::pg_catalog.oid
        ),
        (
          'backup_admin_guard',
          'public.backup_status_mail_admin_guard'
            ::pg_catalog.regclass::pg_catalog.oid
        )
    ),
    hardened_relations(relation_label, relation_oid, expected_natts) AS (
      VALUES
        (
          'outbox'::pg_catalog.text,
          'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
          37::pg_catalog.int2
        ),
        (
          'replay_authority',
          'public.email_outbox_idempotency_authority'
            ::pg_catalog.regclass::pg_catalog.oid,
          2::pg_catalog.int2
        ),
        (
          'backup_authority',
          'public.backup_status_mail_authority'
            ::pg_catalog.regclass::pg_catalog.oid,
          7::pg_catalog.int2
        ),
        (
          'backup_admin_guard',
          'public.backup_status_mail_admin_guard'
            ::pg_catalog.regclass::pg_catalog.oid,
          2::pg_catalog.int2
        ),
        (
          'receipt',
          receipt_oid,
          8::pg_catalog.int2
        )
    ),
    table_privileges(privilege_name) AS (
      VALUES
        ('delete'::pg_catalog.text),
        ('insert'),
        ('maintain'),
        ('references'),
        ('select'),
        ('trigger'),
        ('truncate'),
        ('update')
    ),
    expected_direct_relation_acl AS (
      SELECT
        protected.relation_oid,
        'learncoding_owner'::pg_catalog.text AS grantee_name,
        'learncoding_owner'::pg_catalog.text AS grantor_name,
        privilege.privilege_name,
        false AS is_grantable
        FROM protected_relations AS protected
        CROSS JOIN table_privileges AS privilege
      UNION ALL
      SELECT
        'public.email_outbox'::pg_catalog.regclass::pg_catalog.oid,
        runtime_acl.grantee_name,
        'learncoding_owner'::pg_catalog.text,
        runtime_acl.privilege_name,
        false
        FROM (VALUES
          ('learncoding_app'::pg_catalog.text, 'delete'::pg_catalog.text),
          ('learncoding_app', 'select'),
          ('learncoding_worker', 'select'),
          ('learncoding_ops', 'delete'),
          ('learncoding_ops', 'select')
        ) AS runtime_acl(grantee_name, privilege_name)
    ),
    actual_direct_relation_acl AS (
      SELECT
        relation.oid AS relation_oid,
        CASE
          WHEN access.grantee = 0 THEN 'PUBLIC'
          ELSE pg_catalog.pg_get_userbyid(access.grantee)
        END::pg_catalog.text AS grantee_name,
        CASE
          WHEN access.grantor = 0 THEN 'PUBLIC'
          ELSE pg_catalog.pg_get_userbyid(access.grantor)
        END::pg_catalog.text AS grantor_name,
        pg_catalog.lower(access.privilege_type)::pg_catalog.text
          AS privilege_name,
        access.is_grantable
        FROM protected_relations AS protected
        JOIN pg_catalog.pg_class AS relation
          ON relation.oid = protected.relation_oid
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            relation.relacl,
            pg_catalog.acldefault('r', relation.relowner)
          )
        ) AS access
    ),
    direct_relation_acl_delta AS (
      SELECT *
        FROM (
          SELECT * FROM expected_direct_relation_acl
          EXCEPT ALL
          SELECT * FROM actual_direct_relation_acl
        ) AS missing_direct_relation_acl
      UNION ALL
      SELECT *
        FROM (
          SELECT * FROM actual_direct_relation_acl
          EXCEPT ALL
          SELECT * FROM expected_direct_relation_acl
        ) AS unexpected_direct_relation_acl
    ),    expected_direct_column_rules(
      relation_label,
      grantee_name,
      privilege_name,
      column_names
    ) AS (
      VALUES
        (
          'outbox'::pg_catalog.text,
          'learncoding_app'::pg_catalog.text,
          'insert'::pg_catalog.text,
          ARRAY[
            'id', 'operation_id', 'user_id', 'delivery_scope_key',
            'to_email', 'template', 'template_version', 'variables',
            'idempotency_key', 'idempotency_authority_version',
            'status', 'next_attempt_at'
          ]::pg_catalog.text[]
        ),
        (
          'outbox',
          'learncoding_worker',
          'insert',
          ARRAY[
            'operation_id', 'user_id', 'delivery_scope_key', 'to_email',
            'template', 'template_version', 'variables', 'idempotency_key',
            'idempotency_authority_version', 'status', 'next_attempt_at'
          ]::pg_catalog.text[]
        ),
        (
          'outbox',
          'learncoding_worker',
          'update',
          ARRAY[
            'status', 'claim_token', 'claim_owner', 'claim_version',
            'lease_expires_at', 'attempt_count', 'last_error_code',
            'updated_at', 'next_attempt_at', 'provider_call_started',
            'adapter', 'dispatch_binding_version', 'dispatch_binding_sha256',
            'provider_correlation_version', 'provider_evidence_version',
            'provider_evidence_sha256', 'provider_message_id', 'sent_at',
            'quarantined_at', 'provider_request_body_sha256',
            'provider_request_body_length'
          ]::pg_catalog.text[]
        ),
        (
          'receipt',
          'learncoding_worker',
          'select',
          ARRAY[
            'outbox_id', 'operation_id', 'idempotency_authority_version',
            'idempotency_authority_sha256',
            'idempotency_original_payload_sha256', 'release_version',
            'release_receipt_sha256'
          ]::pg_catalog.text[]
        )
    ),
    expected_direct_column_acl AS (
      SELECT
        protected.relation_oid,
        column_name.column_name,
        rule.grantee_name,
        'learncoding_owner'::pg_catalog.text AS grantor_name,
        rule.privilege_name,
        false AS is_grantable
        FROM expected_direct_column_rules AS rule
        JOIN protected_relations AS protected
          ON protected.relation_label = rule.relation_label
        CROSS JOIN LATERAL pg_catalog.unnest(
          rule.column_names
        ) AS column_name(column_name)
    ),
    actual_direct_column_acl AS (
      SELECT
        protected.relation_oid,
        attribute.attname::pg_catalog.text AS column_name,
        CASE WHEN access.grantee = 0 THEN 'PUBLIC'
             ELSE pg_catalog.pg_get_userbyid(access.grantee)
        END::pg_catalog.text AS grantee_name,
        CASE WHEN access.grantor = 0 THEN 'PUBLIC'
             ELSE pg_catalog.pg_get_userbyid(access.grantor)
        END::pg_catalog.text AS grantor_name,
        pg_catalog.lower(access.privilege_type)::pg_catalog.text
          AS privilege_name,
        access.is_grantable
        FROM protected_relations AS protected
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = protected.relation_oid
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
        CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS access
    ),
    direct_column_acl_delta AS (
      SELECT * FROM (
        SELECT * FROM expected_direct_column_acl
        EXCEPT ALL
        SELECT * FROM actual_direct_column_acl
      ) AS missing_direct_column_acl
      UNION ALL
      SELECT * FROM (
        SELECT * FROM actual_direct_column_acl
        EXCEPT ALL
        SELECT * FROM expected_direct_column_acl
      ) AS unexpected_direct_column_acl
    ),
    reviewed_acl_routines(routine_label, routine_oid) AS (
      VALUES
        ('append_only'::pg_catalog.text,
         pg_catalog.to_regprocedure(
           'public.enforce_mail_delivery_release_receipt_append_only()'
         )::pg_catalog.oid),
        ('backup_authorized',
         pg_catalog.to_regprocedure(
           'public.backup_status_mail_authorized(uuid)'
         )::pg_catalog.oid),
        ('backup_internal',
         pg_catalog.to_regprocedure(
           'public.enqueue_backup_status_mail_authority_unreleased_0067(text,text)'
         )::pg_catalog.oid),
        ('backup_lock',
         pg_catalog.to_regprocedure(
           'public.lock_backup_status_mail_admin_authority()'
         )::pg_catalog.oid),
        ('backup_reject',
         pg_catalog.to_regprocedure(
           'public.reject_backup_status_mail_authority_mutation()'
         )::pg_catalog.oid),
        ('backup_wrapper',
         pg_catalog.to_regprocedure(
           'public.enqueue_backup_status_mail_authority(text,text)'
         )::pg_catalog.oid),
        ('commit_exact',
         pg_catalog.to_regprocedure(
           'public.enforce_email_outbox_delivery_release_commit_exact()'
         )::pg_catalog.oid),
        ('hash',
         pg_catalog.to_regprocedure(
           'public.mail_delivery_release_receipt_sha256(uuid,uuid,text,text,text,text)'
         )::pg_catalog.oid),
        ('hold',
         pg_catalog.to_regprocedure(
           'public.enforce_email_outbox_delivery_hold()'
         )::pg_catalog.oid),
        ('identity',
         pg_catalog.to_regprocedure(
           'public.enforce_email_outbox_delivery_release_identity()'
         )::pg_catalog.oid),
        ('insert_final',
         pg_catalog.to_regprocedure(
           'public.enforce_email_outbox_delivery_release_insert_final()'
         )::pg_catalog.oid),
        ('issuer',
         pg_catalog.to_regprocedure(
           'public.release_email_outbox_delivery(uuid,uuid,text,text,text)'
         )::pg_catalog.oid),
        ('marker',
         pg_catalog.to_regprocedure(
           'public.enforce_email_outbox_delivery_release_insert_xid()'
         )::pg_catalog.oid),
        ('outbox_delete_exact',
         pg_catalog.to_regprocedure(
           'public.enforce_email_outbox_delivery_release_delete_exact()'
         )::pg_catalog.oid),
        ('payload',
         pg_catalog.to_regprocedure(
           'public.enforce_email_outbox_payload_immutable()'
         )::pg_catalog.oid),
        ('receipt_delete_exact',
         pg_catalog.to_regprocedure(
           'public.enforce_mail_delivery_release_receipt_delete_exact()'
         )::pg_catalog.oid),
        ('receipt_insert',
         pg_catalog.to_regprocedure(
           'public.enforce_mail_delivery_release_receipt_insert()'
         )::pg_catalog.oid),
        ('request_guard',
         pg_catalog.to_regprocedure(
           'public.enforce_email_outbox_provider_request_body_immutable()'
         )::pg_catalog.oid),
        ('verifier',
         pg_catalog.to_regprocedure(
           'public.verify_email_outbox_delivery_release(uuid,uuid,text,text,text)'
         )::pg_catalog.oid)
    ),    expected_effective_function_authority AS (
      SELECT
        principal.principal_name,
        routine.routine_label,
        (
          principal.principal_name = 'learncoding_owner'
          OR (
            principal.principal_name = 'learncoding_app'
            AND routine.routine_label = 'issuer'
          )
          OR (
            principal.principal_name = 'learncoding_app'
            AND routine.routine_label = 'verifier'
          )
          OR (
            principal.principal_name = 'learncoding_worker'
            AND routine.routine_label = 'issuer'
          )
          OR (
            principal.principal_name = 'learncoding_backup_reporter'
            AND routine.routine_label = 'backup_wrapper'
          )
          OR (
            principal.principal_name = 'learncoding_worker'
            AND routine.routine_label = 'backup_authorized'
          )
          OR (
            principal.principal_name = 'learncoding_worker'
            AND routine.routine_label = 'hash'
          )
        ) AS permitted
        FROM managed_principals AS principal
        CROSS JOIN reviewed_acl_routines AS routine
    ),
    actual_effective_function_authority AS (
      SELECT
        principal.principal_name,
        routine.routine_label,
        pg_catalog.has_function_privilege(
          principal.principal_oid,
          routine.routine_oid,
          'EXECUTE'
        ) AS permitted
        FROM managed_principals AS principal
        CROSS JOIN reviewed_acl_routines AS routine
    ),
    expected_effective_relation_authority AS (
      SELECT
        principal.principal_name,
        protected.relation_label,
        privilege.privilege_name,
        (
          principal.principal_name = 'learncoding_owner'
          OR (
            protected.relation_label = 'outbox'
            AND (
              (
                principal.principal_name IN (
                  'learncoding_app', 'learncoding_ops'
                )
                AND privilege.privilege_name IN ('delete', 'select')
              )
              OR (
                principal.principal_name = 'learncoding_worker'
                AND privilege.privilege_name = 'select'
              )
            )
          )
        ) AS permitted
        FROM managed_principals AS principal
        CROSS JOIN protected_relations AS protected
        CROSS JOIN table_privileges AS privilege
    ),
    actual_effective_relation_authority AS (
      SELECT
        principal.principal_name,
        protected.relation_label,
        privilege.privilege_name,
        pg_catalog.has_table_privilege(
          principal.principal_oid,
          protected.relation_oid,
          privilege.privilege_name
        ) AS permitted
        FROM managed_principals AS principal
        CROSS JOIN protected_relations AS protected
        CROSS JOIN table_privileges AS privilege
    ),
    column_privileges(privilege_name) AS (
      VALUES
        ('insert'::pg_catalog.text),
        ('references'),
        ('select'),
        ('update')
    ),
    protected_columns(relation_label, relation_oid, column_name) AS (
      SELECT
        protected.relation_label,
        protected.relation_oid,
        attribute.attname::pg_catalog.text
        FROM protected_relations AS protected
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = protected.relation_oid
       WHERE attribute.attnum > 0
         AND NOT attribute.attisdropped
    ),
    expected_effective_column_authority AS (
      SELECT
        principal.principal_name,
        protected.relation_label,
        protected.column_name,
        privilege.privilege_name,
        (
          principal.principal_name = 'learncoding_owner'
          OR (
            protected.relation_label = 'outbox'
            AND principal.principal_name IN (
              'learncoding_app', 'learncoding_worker', 'learncoding_ops'
            )
            AND privilege.privilege_name = 'select'
          )
          OR EXISTS (
            SELECT 1
              FROM expected_direct_column_rules AS rule
             WHERE rule.relation_label = protected.relation_label
               AND rule.grantee_name = principal.principal_name
               AND rule.privilege_name = privilege.privilege_name
               AND protected.column_name = ANY(rule.column_names)
          )
        ) AS permitted
        FROM managed_principals AS principal
        CROSS JOIN protected_columns AS protected
        CROSS JOIN column_privileges AS privilege
    ),
    actual_effective_column_authority AS (
      SELECT
        principal.principal_name,
        protected.relation_label,
        protected.column_name,
        privilege.privilege_name,
        pg_catalog.has_column_privilege(
          principal.principal_oid,
          protected.relation_oid,
          protected.column_name,
          privilege.privilege_name
        ) AS permitted
        FROM managed_principals AS principal
        CROSS JOIN protected_columns AS protected
        CROSS JOIN column_privileges AS privilege
    ),
    managed_role_names(role_name) AS (
      VALUES
        ('learncoding_owner'::pg_catalog.text),
        ('learncoding_migrator'),
        ('learncoding_app'),
        ('learncoding_worker'),
        ('learncoding_ops'),
        ('learncoding_backup_reporter')
    ),
    expected_managed_memberships(
      member_name,
      role_name,
      admin_option,
      inherit_option,
      set_option
    ) AS (
      VALUES (
        'learncoding_migrator'::pg_catalog.text,
        'learncoding_owner'::pg_catalog.text,
        false,
        false,
        true
      )
    ),
    actual_managed_memberships AS (
      SELECT
        member_role.rolname::pg_catalog.text AS member_name,
        granted_role.rolname::pg_catalog.text AS role_name,
        membership.admin_option,
        membership.inherit_option,
        membership.set_option
        FROM pg_catalog.pg_auth_members AS membership
        JOIN pg_catalog.pg_roles AS member_role
          ON member_role.oid = membership.member
        JOIN pg_catalog.pg_roles AS granted_role
          ON granted_role.oid = membership.roleid
       WHERE member_role.rolname IN (
               SELECT managed.role_name FROM managed_role_names AS managed
             )
          OR granted_role.rolname IN (
               SELECT managed.role_name FROM managed_role_names AS managed
             )
    ),
    managed_membership_delta AS (
      SELECT *
        FROM (
          SELECT * FROM expected_managed_memberships
          EXCEPT ALL
          SELECT * FROM actual_managed_memberships
        ) AS missing_managed_memberships
      UNION ALL
      SELECT *
        FROM (
          SELECT * FROM actual_managed_memberships
          EXCEPT ALL
          SELECT * FROM expected_managed_memberships
        ) AS unexpected_managed_memberships
    ),
    expected_managed_roles(
      role_name,
      can_login,
      is_superuser,
      can_create_database,
      can_create_role,
      inherits_privileges,
      can_replicate,
      bypasses_rls
    ) AS (
      VALUES
        ('learncoding_owner'::pg_catalog.text,
         false, false, false, false, false, false, false),
        ('learncoding_migrator',
         true, false, false, false, false, false, false),
        ('learncoding_app',
         true, false, false, false, false, false, false),
        ('learncoding_worker',
         true, false, false, false, false, false, false),
        ('learncoding_ops',
         true, false, false, false, false, false, false),
        ('learncoding_backup_reporter',
         true, false, false, false, false, false, false)
    ),
    actual_managed_roles AS (
      SELECT
        role.rolname::pg_catalog.text AS role_name,
        role.rolcanlogin AS can_login,
        role.rolsuper AS is_superuser,
        role.rolcreatedb AS can_create_database,
        role.rolcreaterole AS can_create_role,
        role.rolinherit AS inherits_privileges,
        role.rolreplication AS can_replicate,
        role.rolbypassrls AS bypasses_rls
        FROM pg_catalog.pg_roles AS role
       WHERE role.rolname IN (
         SELECT managed.role_name FROM managed_role_names AS managed
       )
    ),
    managed_role_delta AS (
      SELECT *
        FROM (
          SELECT * FROM expected_managed_roles
          EXCEPT ALL
          SELECT * FROM actual_managed_roles
        ) AS missing_managed_roles
      UNION ALL
      SELECT *
        FROM (
          SELECT * FROM actual_managed_roles
          EXCEPT ALL
          SELECT * FROM expected_managed_roles
        ) AS unexpected_managed_roles
    ),
    role_path_kinds(kind_name) AS (
      VALUES
        ('MEMBER'::pg_catalog.text),
        ('SET'),
        ('USAGE')
    ),
    expected_managed_role_paths AS (
      SELECT
        member.role_name AS member_name,
        granted.role_name AS role_name,
        kind.kind_name,
        (
          member.role_name = 'learncoding_migrator'
          AND granted.role_name = 'learncoding_owner'
          AND kind.kind_name IN ('MEMBER', 'SET')
        ) AS permitted
        FROM managed_role_names AS member
        CROSS JOIN managed_role_names AS granted
        CROSS JOIN role_path_kinds AS kind
       WHERE member.role_name <> granted.role_name
    ),
    actual_managed_role_paths AS (
      SELECT
        member.role_name AS member_name,
        granted.role_name AS role_name,
        kind.kind_name,
        pg_catalog.pg_has_role(
          member.role_name,
          granted.role_name,
          kind.kind_name
        ) AS permitted
        FROM managed_role_names AS member
        CROSS JOIN managed_role_names AS granted
        CROSS JOIN role_path_kinds AS kind
       WHERE member.role_name <> granted.role_name
    ),
    relation_topology_failure AS (
      SELECT 1
        FROM hardened_relations AS hardened
        LEFT JOIN pg_catalog.pg_class AS relation
          ON relation.oid = hardened.relation_oid
       WHERE relation.oid IS NULL
          OR relation.relkind <> 'r'
          OR relation.relpersistence <> 'p'
          OR relation.relnatts <> hardened.expected_natts
          OR relation.reloptions IS NOT NULL
          OR relation.relreplident <> 'd'
          OR relation.relam IS DISTINCT FROM (
            SELECT access_method.oid
              FROM pg_catalog.pg_am AS access_method
             WHERE access_method.amname = 'heap'
               AND access_method.amtype = 't'
          )
          OR relation.relrowsecurity
          OR relation.relforcerowsecurity
          OR relation.relispartition
          OR relation.relpartbound IS NOT NULL
          OR relation.reloftype <> 0
          OR relation.relhasrules
          OR pg_catalog.pg_get_userbyid(relation.relowner) <>
               'learncoding_owner'
          OR EXISTS (
            SELECT 1
              FROM pg_catalog.pg_attribute AS attribute
             WHERE attribute.attrelid = relation.oid
               AND attribute.attnum > 0
               AND attribute.attisdropped
          )
          OR EXISTS (
            SELECT 1
              FROM pg_catalog.pg_inherits AS inheritance
             WHERE inheritance.inhrelid = relation.oid
                OR inheritance.inhparent = relation.oid
          )
          OR EXISTS (
            SELECT 1
              FROM pg_catalog.pg_partitioned_table AS partitioning
             WHERE partitioning.partrelid = relation.oid
          )
          OR EXISTS (
            SELECT 1
              FROM pg_catalog.pg_policy AS policy
             WHERE policy.polrelid = relation.oid
          )
          OR EXISTS (
            SELECT 1
              FROM pg_catalog.pg_rewrite AS rewrite
             WHERE rewrite.ev_class = relation.oid
          )
    ),
    acl_topology_failure AS (
      SELECT 1 FROM relation_topology_failure
      UNION ALL
      SELECT 1 FROM direct_relation_acl_delta
      UNION ALL
      SELECT 1 FROM direct_column_acl_delta
      UNION ALL
      SELECT 1
        FROM expected_effective_function_authority AS expected
        JOIN actual_effective_function_authority AS actual
          USING (principal_name, routine_label)
       WHERE actual.permitted IS DISTINCT FROM expected.permitted
      UNION ALL
      SELECT 1
        FROM expected_effective_relation_authority AS expected
        JOIN actual_effective_relation_authority AS actual
          USING (principal_name, relation_label, privilege_name)
       WHERE actual.permitted IS DISTINCT FROM expected.permitted
      UNION ALL
      SELECT 1
        FROM expected_effective_column_authority AS expected
        JOIN actual_effective_column_authority AS actual
          USING (
            principal_name,
            relation_label,
            column_name,
            privilege_name
          )
       WHERE actual.permitted IS DISTINCT FROM expected.permitted
      UNION ALL
      SELECT 1
        FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid =
             'public.email_outbox_idempotency_authority'
               ::pg_catalog.regclass
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
         AND attribute.attacl IS NOT NULL
      UNION ALL
      SELECT 1 FROM managed_membership_delta
      UNION ALL
      SELECT 1 FROM managed_role_delta
      UNION ALL
      SELECT 1
        FROM expected_managed_role_paths AS expected
        JOIN actual_managed_role_paths AS actual
          USING (member_name, role_name, kind_name)
       WHERE actual.permitted IS DISTINCT FROM expected.permitted
    )
    SELECT 1 FROM acl_topology_failure
  )
  THEN
    RAISE EXCEPTION '0069 terminal catalog contract is invalid'
      USING ERRCODE = '42501';
  END IF;
END
$verify_terminal_catalog$;
