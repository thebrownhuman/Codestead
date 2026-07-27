import {
  MAIL_DISPATCH_RUNTIME_BOOTSTRAP,
  MAIL_DISPATCH_RUNTIME_DEFAULTS,
  isMailDispatchRuntimePlan,
  planMailDispatchRuntime,
  type MailDispatchRuntimePlan,
} from "./mail-dispatch-runtime-policy";

import {
  connectMailDispatchDbWithin,
  createMailDispatchDbDeadline,
  queryMailDispatchDbWithin,
  type MailDispatchDbClient,
  type MailDispatchDbClientLease,
} from "./mail-dispatch-db-deadline";

const MINIMUM_MAIL_DISPATCH_POSTGRES_MAJOR = 17;
const FAILURE_MESSAGE = "Mail dispatch requires PostgreSQL 17 or newer.";
const DELIVERY_AUTHORITY_FAILURE_MESSAGE =
  "Mail delivery authority is unavailable.";
const GUARDED_DELIVERY_MIGRATION_SHA256 =
  "da33b7f35d6fe75c750e8ffdea9717e0c27098b7bb2a6a2e458cc9c7e2e9ec9c";

type RuntimeVersionRow = {
  readonly server_version_num: unknown;
};

type DeliveryAuthorityRuntimeRow = {
  readonly delivery_release_capability_exact: unknown;
  readonly hold_catalog_exact: unknown;
  readonly hold_catalog_present: unknown;
};

export type PostgresRuntimeQueryable = {
  query(queryText: string): Promise<{
    readonly rows: readonly unknown[];
  }>;
};

export class MailDispatchPostgresRuntimeError extends Error {
  constructor() {
    super(FAILURE_MESSAGE);
    this.name = "POSTGRES_RUNTIME_UNSUPPORTED";
  }
}

export class MailDeliveryAuthorityRuntimeError extends Error {
  constructor() {
    super(DELIVERY_AUTHORITY_FAILURE_MESSAGE);
    this.name = "MAIL_DELIVERY_AUTHORITY_UNAVAILABLE";
  }
}

export type MailDeliveryAuthorityRuntimeVerdict = {
  readonly holdCatalogExact: boolean;
  readonly deliveryReleaseCapabilityExact: boolean;
};

function parseDeliveryAuthorityRuntimeRow(
  row: DeliveryAuthorityRuntimeRow | undefined,
): MailDeliveryAuthorityRuntimeVerdict {
  if (
    typeof row?.hold_catalog_present !== "boolean" ||
    typeof row.hold_catalog_exact !== "boolean" ||
    typeof row.delivery_release_capability_exact !== "boolean" ||
    row.hold_catalog_present !== row.hold_catalog_exact ||
    (row.delivery_release_capability_exact && !row.hold_catalog_exact)
  ) {
    throw new MailDeliveryAuthorityRuntimeError();
  }

  return {
    holdCatalogExact: row.hold_catalog_exact,
    deliveryReleaseCapabilityExact: row.delivery_release_capability_exact,
  };
}

export function parsePostgresServerVersionNum(versionNum: unknown): {
  readonly major: number;
  readonly versionNum: number;
} {
  if (
    typeof versionNum !== "string" ||
    !/^[1-9][0-9]{4,7}$/u.test(versionNum)
  ) {
    throw new MailDispatchPostgresRuntimeError();
  }

  const parsedVersionNum = Number.parseInt(versionNum, 10);
  const major = Math.floor(parsedVersionNum / 10_000);
  if (
    !Number.isSafeInteger(parsedVersionNum) ||
    major < MINIMUM_MAIL_DISPATCH_POSTGRES_MAJOR
  ) {
    throw new MailDispatchPostgresRuntimeError();
  }

  return { major, versionNum: parsedVersionNum };
}

export async function requireMailDispatchPostgresRuntime(
  database: PostgresRuntimeQueryable,
): Promise<{
  readonly major: number;
  readonly versionNum: number;
}> {
  try {
    const result = await database.query(
      "select pg_catalog.current_setting('server_version_num') as server_version_num",
    );
    if (result.rows.length !== 1) {
      throw new MailDispatchPostgresRuntimeError();
    }
    const row = result.rows[0] as RuntimeVersionRow | undefined;
    return parsePostgresServerVersionNum(row?.server_version_num);
  } catch {
    throw new MailDispatchPostgresRuntimeError();
  }
}

/**
 * Detects the Task 5 hold and proves the reviewed Task 7 release capability.
 *
 * The applied 0069 hash is paired with live catalog, function-body, and ACL
 * checks because migration lineage alone cannot prove that privileged objects
 * remain unchanged after deployment.
 */
export async function requireMailDeliveryAuthorityRuntime(
  database: PostgresRuntimeQueryable,
): Promise<MailDeliveryAuthorityRuntimeVerdict> {
  try {
    const result = await database.query(`
      WITH hold_column AS (
        SELECT
          pg_catalog.count(*)::pg_catalog.int4 AS footprint_count,
          COALESCE(
            pg_catalog.bool_and(
              attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
              AND attribute.attnotnull
              AND NOT attribute.atthasdef
              AND attribute.attgenerated = ''
            ),
            FALSE
          ) AS structure_exact
        FROM pg_catalog.pg_attribute AS attribute
        JOIN pg_catalog.pg_class AS relation
          ON relation.oid = attribute.attrelid
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = 'email_outbox'
          AND relation.relkind IN ('r', 'p')
          AND attribute.attname = 'delivery_hold_version'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      ),
      migration_lineage AS (
        SELECT attested.*
          FROM public.attest_email_outbox_delivery_release_lineage(
          '${GUARDED_DELIVERY_MIGRATION_SHA256}'
        ) AS attested
      ),
      lineage_attestor AS (
        SELECT routine.*, language.lanname
          FROM pg_catalog.pg_proc AS routine
          JOIN pg_catalog.pg_language AS language
            ON language.oid = routine.prolang
         WHERE routine.oid = pg_catalog.to_regprocedure(
           'public.attest_email_outbox_delivery_release_lineage(text)'
         )
      ),
      lineage_attestor_catalog AS (
        SELECT
          pg_catalog.count(*) = 1
          AND COALESCE(pg_catalog.bool_and(
            pg_catalog.pg_get_userbyid(attestor.proowner) =
              'learncoding_owner'
            AND attestor.lanname = 'plpgsql'
            AND attestor.prokind = 'f'
            AND attestor.prorettype =
              'pg_catalog.record'::pg_catalog.regtype
            AND attestor.proretset
            AND attestor.provolatile = 's'
            AND attestor.prosecdef
            AND NOT attestor.proleakproof
            AND NOT attestor.proisstrict
            AND attestor.proparallel = 'u'
            AND attestor.proconfig = ARRAY[
              'search_path=pg_catalog, pg_temp'
            ]::pg_catalog.text[]
            AND attestor.pronargs = 1
            AND attestor.pronargdefaults = 0
            AND attestor.proargdefaults IS NULL
            AND attestor.proargnames = ARRAY[
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
                FROM pg_catalog.unnest(
                  attestor.proargtypes
                ) AS input_type
            )::pg_catalog.oid[] = ARRAY[
              'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid
            ]::pg_catalog.oid[]
            AND attestor.proallargtypes = ARRAY[
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
                FROM pg_catalog.unnest(
                  attestor.proargmodes
                ) AS argument_mode
            )::pg_catalog.text[] =
              ARRAY['i', 't', 't', 't', 't', 't', 't']::pg_catalog.text[]
            AND attestor.protrftypes IS NULL
            AND attestor.provariadic = 0
            AND attestor.prosupport = 0
            AND attestor.procost = 100
            AND attestor.prorows = 1000
            AND attestor.probin IS NULL
            AND attestor.prosqlbody IS NULL
            AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
              attestor.prosrc, 'UTF8'
            )), 'hex') =
              'ef2bcb7f6642b27b9e30fd0c91a9d3d031f8d5a5e0f3647a9f7a57cab7bdc57a'
            AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
              pg_catalog.pg_get_functiondef(attestor.oid), 'UTF8'
            )), 'hex') =
              '57e575a169040050c389d00c766cc35e32e0b32fae9c4f369e598f506aceb21d'
            AND (
              SELECT pg_catalog.count(*)
                FROM pg_catalog.pg_proc AS overload
               WHERE overload.pronamespace =
                     'public'::pg_catalog.regnamespace
                 AND overload.proname =
                     'attest_email_outbox_delivery_release_lineage'
            ) = 1
          ), FALSE) AS structure_exact,
          COALESCE(pg_catalog.bool_and(
            COALESCE((
              SELECT pg_catalog.array_agg(pg_catalog.concat_ws(
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
              ) ORDER BY
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
                FROM pg_catalog.aclexplode(COALESCE(
                  attestor.proacl,
                  pg_catalog.acldefault('f', attestor.proowner)
                )) AS access
            ), ARRAY[]::pg_catalog.text[]) = ARRAY[
              'learncoding_owner|learncoding_owner|execute|false',
              'learncoding_worker|learncoding_owner|execute|false'
            ]::pg_catalog.text[]
            AND pg_catalog.has_function_privilege(
              'learncoding_owner', attestor.oid, 'EXECUTE'
            )
            AND pg_catalog.has_function_privilege(
              'learncoding_worker', attestor.oid, 'EXECUTE'
            )
            AND NOT pg_catalog.has_function_privilege(
              'learncoding_app', attestor.oid, 'EXECUTE'
            )
            AND NOT pg_catalog.has_function_privilege(
              'learncoding_migrator', attestor.oid, 'EXECUTE'
            )
            AND NOT pg_catalog.has_function_privilege(
              'learncoding_ops', attestor.oid, 'EXECUTE'
            )
            AND NOT pg_catalog.has_function_privilege(
              'learncoding_backup_reporter', attestor.oid, 'EXECUTE'
            )
            AND NOT pg_catalog.has_function_privilege(
              0, attestor.oid, 'EXECUTE'
            )
          ), FALSE) AS acl_exact
          FROM lineage_attestor AS attestor
      ),
      receipt_relation AS (
        SELECT relation.*
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = 'mail_delivery_release_receipt'
      ),
      receipt_relation_catalog AS (
        SELECT
          pg_catalog.count(*) = 1
          AND COALESCE(pg_catalog.bool_and(
            relation.relkind = 'r'
            AND relation.relpersistence = 'p'
            AND relation.relnatts = 8
            AND NOT relation.relrowsecurity
            AND NOT relation.relforcerowsecurity
            AND NOT relation.relispartition
            AND relation.relpartbound IS NULL
            AND relation.reloftype = 0
            AND NOT relation.relhasrules
            AND relation.relam = (
              SELECT access_method.oid
              FROM pg_catalog.pg_am AS access_method
              WHERE access_method.amname = 'heap'
                AND access_method.amtype = 't'
            )
            AND pg_catalog.pg_get_userbyid(relation.relowner) =
                  'learncoding_owner'
            AND NOT EXISTS (
              SELECT 1 FROM pg_catalog.pg_inherits AS inheritance
              WHERE inheritance.inhrelid = relation.oid
                 OR inheritance.inhparent = relation.oid
            )
            AND NOT EXISTS (
              SELECT 1 FROM pg_catalog.pg_partitioned_table AS partitioning
              WHERE partitioning.partrelid = relation.oid
            )
            AND NOT EXISTS (
              SELECT 1 FROM pg_catalog.pg_policy AS policy
              WHERE policy.polrelid = relation.oid
            )
            AND NOT EXISTS (
              SELECT 1 FROM pg_catalog.pg_rewrite AS rewrite
              WHERE rewrite.ev_class = relation.oid
            )
          ), FALSE) AS structure_exact
        FROM receipt_relation AS relation
      ),
      receipt_columns AS (
        SELECT
          pg_catalog.count(attribute.attnum) = 8
          AND COALESCE(pg_catalog.bool_and((
            attribute.attnotnull
            AND attribute.atttypmod = -1
            AND attribute.attcollation = CASE
              WHEN attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
                THEN (
                  SELECT type_row.typcollation FROM pg_catalog.pg_type AS type_row
                  WHERE type_row.oid = attribute.atttypid
                )
              ELSE 0
            END
            AND attribute.attcompression = ''::"char"
            AND attribute.attidentity = ''
            AND attribute.attgenerated = ''
            AND NOT attribute.atthasmissing
            AND attribute.attmissingval IS NULL
            AND attribute.attislocal
            AND attribute.attinhcount = 0
            AND attribute.atthasdef = (attribute.attnum = 8)
            AND CASE attribute.attnum
              WHEN 1 THEN attribute.attname = 'outbox_id'
                AND attribute.atttypid = 'pg_catalog.uuid'::pg_catalog.regtype
              WHEN 2 THEN attribute.attname = 'operation_id'
                AND attribute.atttypid = 'pg_catalog.uuid'::pg_catalog.regtype
              WHEN 3 THEN attribute.attname = 'idempotency_authority_version'
                AND attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
              WHEN 4 THEN attribute.attname = 'idempotency_authority_sha256'
                AND attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
              WHEN 5 THEN attribute.attname = 'idempotency_original_payload_sha256'
                AND attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
              WHEN 6 THEN attribute.attname = 'release_version'
                AND attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
              WHEN 7 THEN attribute.attname = 'release_receipt_sha256'
                AND attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
              WHEN 8 THEN attribute.attname = 'released_at'
                AND attribute.atttypid = 'pg_catalog.timestamptz'::pg_catalog.regtype
              ELSE FALSE
            END
          ) IS TRUE), FALSE) AS structure_exact
        FROM receipt_relation AS relation
        LEFT JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = relation.oid
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
      ),
      receipt_default AS (
        SELECT
          pg_catalog.count(default_row.oid) = 1
          AND COALESCE(pg_catalog.bool_and(
            default_row.adnum = 8
            AND pg_catalog.pg_get_expr(
              default_row.adbin, default_row.adrelid, FALSE
            ) = 'statement_timestamp()'
          ) FILTER (WHERE default_row.oid IS NOT NULL), FALSE)
            AS structure_exact
        FROM receipt_relation AS relation
        LEFT JOIN pg_catalog.pg_attrdef AS default_row
          ON default_row.adrelid = relation.oid
      ),
      receipt_not_null_constraints AS (
        SELECT CASE
          WHEN pg_catalog.current_setting('server_version_num')::pg_catalog.int4
                 >= 180000
            THEN (
              SELECT pg_catalog.count(DISTINCT constraint_row.conkey[1]) = 8
              FROM receipt_relation AS relation
              JOIN pg_catalog.pg_constraint AS constraint_row
                ON constraint_row.conrelid = relation.oid
              WHERE constraint_row.connamespace =
                      'public'::pg_catalog.regnamespace
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
                  (pg_catalog.to_jsonb(constraint_row)->>'conenforced')
                    ::pg_catalog.bool,
                  TRUE
                )
            ) AND (
              SELECT pg_catalog.count(*) = 8
              FROM receipt_relation AS relation
              JOIN pg_catalog.pg_constraint AS constraint_row
                ON constraint_row.conrelid = relation.oid
              WHERE constraint_row.contype = 'n'
            )
          ELSE (
            SELECT pg_catalog.count(*) = 0
            FROM receipt_relation AS relation
            JOIN pg_catalog.pg_constraint AS constraint_row
              ON constraint_row.conrelid = relation.oid
            WHERE constraint_row.contype = 'n'
          )
        END AS structure_exact
      ),
      expected_receipt_constraints(
        constraint_name,
        constraint_type,
        key_columns,
        index_oid,
        is_deferrable,
        initially_deferred,
        no_inherit,
        definition_sha256
      ) AS (
        VALUES
          (
            'mail_delivery_release_receipt_authority_version_valid'
              ::pg_catalog.text,
            'c'::"char", ARRAY[3,4,5]::pg_catalog.int2[],
            0::pg_catalog.oid,
            FALSE, FALSE, FALSE,
            '17258e40bf2d8255135dc1c7283f0afa789e55d103eaf6d64b68f9c9d92eaae4'
              ::pg_catalog.text
          ),
          (
            'mail_delivery_release_receipt_digest_exact',
            'c'::"char", ARRAY[7,1,2,3,4,5,6]::pg_catalog.int2[],
            0::pg_catalog.oid,
            FALSE, FALSE, FALSE,
            'e15d12ca6ebec8c01ebd06c12b6644ed98aed74f2324cefe79ee284a554d6921'
          ),
          (
            'mail_delivery_release_receipt_digest_unique',
            'u'::"char", ARRAY[7]::pg_catalog.int2[],
            'public.mail_delivery_release_receipt_digest_unique'
              ::pg_catalog.regclass::pg_catalog.oid,
            FALSE, FALSE, TRUE,
            'eac9079638de5b93751ad98ec465bcb8df523d896fec82a9a85becfb57e11e76'
          ),
          (
            'mail_delivery_release_receipt_digest_valid',
            'c'::"char", ARRAY[7]::pg_catalog.int2[],
            0::pg_catalog.oid,
            FALSE, FALSE, FALSE,
            'f52f84f271dcc21c4f726913d18aa774aafcd5b319f2b3314159c416ac1e83f0'
          ),
          (
            'mail_delivery_release_receipt_idempotency_authority_fk',
            'f'::"char", ARRAY[4,5]::pg_catalog.int2[],
            'public.email_outbox_idempotency_authority_payload_unique'
              ::pg_catalog.regclass::pg_catalog.oid,
            TRUE, TRUE, TRUE,
            '69f0fb95c52b6cbc54abd0b2a4e444320899d2a0c75ee6865e4225af86de1561'
          ),
          (
            'mail_delivery_release_receipt_outbox_fk',
            'f'::"char", ARRAY[1,2]::pg_catalog.int2[],
            'public.email_outbox_delivery_release_parent_unique'
              ::pg_catalog.regclass::pg_catalog.oid,
            FALSE, FALSE, TRUE,
            'a404224075eb2229356afced34903caa44c5621308b335ec68fa36104584cc4b'
          ),
          (
            'mail_delivery_release_receipt_operation_unique',
            'u'::"char", ARRAY[2]::pg_catalog.int2[],
            'public.mail_delivery_release_receipt_operation_unique'
              ::pg_catalog.regclass::pg_catalog.oid,
            FALSE, FALSE, TRUE,
            'ceda61a9e51c434fdd6437c1ee7697e3efca12a088f334255c0e095a310bc1db'
          ),
          (
            'mail_delivery_release_receipt_pkey',
            'p'::"char", ARRAY[1]::pg_catalog.int2[],
            'public.mail_delivery_release_receipt_pkey'
              ::pg_catalog.regclass::pg_catalog.oid,
            FALSE, FALSE, TRUE,
            '66060e6653fde114e853a55e2ffe9b592976948dc2505d2d3190652c3d76b18f'
          ),
          (
            'mail_delivery_release_receipt_release_version_valid',
            'c'::"char", ARRAY[6]::pg_catalog.int2[],
            0::pg_catalog.oid,
            FALSE, FALSE, FALSE,
            '0f1cc09b02197483a4caba15e736bd7552f393d76aa66040771183230014a48a'
          )
      ),
      receipt_constraints AS (
        SELECT (
          SELECT pg_catalog.count(*) = 9
          FROM expected_receipt_constraints AS expected
          JOIN receipt_relation AS relation ON TRUE
          JOIN pg_catalog.pg_constraint AS constraint_row
            ON constraint_row.conrelid = relation.oid
           AND constraint_row.conname = expected.constraint_name
          WHERE constraint_row.connamespace =
                  'public'::pg_catalog.regnamespace
            AND constraint_row.contype = expected.constraint_type
            AND constraint_row.conkey = expected.key_columns
            AND constraint_row.conindid = expected.index_oid
            AND constraint_row.condeferrable = expected.is_deferrable
            AND constraint_row.condeferred = expected.initially_deferred
            AND constraint_row.connoinherit = expected.no_inherit
            AND constraint_row.convalidated
            AND constraint_row.conislocal
            AND constraint_row.coninhcount = 0
            AND constraint_row.conparentid = 0
            AND constraint_row.contypid = 0
            AND COALESCE(
              (pg_catalog.to_jsonb(constraint_row)->>'conenforced')
                ::pg_catalog.bool,
              TRUE
            )
            AND NOT COALESCE(
              (pg_catalog.to_jsonb(constraint_row)->>'conperiod')
                ::pg_catalog.bool,
              FALSE
            )
            AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
              pg_catalog.pg_get_constraintdef(constraint_row.oid, FALSE),
              'UTF8'
            )), 'hex') = expected.definition_sha256
        ) AND (
          SELECT pg_catalog.count(*) = 9
          FROM receipt_relation AS relation
          JOIN pg_catalog.pg_constraint AS constraint_row
            ON constraint_row.conrelid = relation.oid
          WHERE constraint_row.contype IN ('c', 'p', 'u', 'f')
        ) AS structure_exact
      ),
      expected_receipt_triggers(
        trigger_name,
        function_oid,
        trigger_type,
        is_constraint,
        is_deferrable,
        initially_deferred,
        exact_shape
      ) AS (
        VALUES
          (
            'mail_delivery_release_receipt_insert_authority'::pg_catalog.text,
            pg_catalog.to_regprocedure(
              'public.enforce_mail_delivery_release_receipt_insert()'
            )::pg_catalog.oid,
            7::pg_catalog.int2, FALSE, FALSE, FALSE, TRUE
          ),
          (
            'mail_delivery_release_receipt_append_only',
            pg_catalog.to_regprocedure(
              'public.enforce_mail_delivery_release_receipt_append_only()'
            )::pg_catalog.oid,
            19::pg_catalog.int2, FALSE, FALSE, FALSE, TRUE
          ),
          (
            'mail_delivery_release_receipt_no_truncate',
            pg_catalog.to_regprocedure(
              'public.enforce_mail_delivery_release_receipt_append_only()'
            )::pg_catalog.oid,
            34::pg_catalog.int2, FALSE, FALSE, FALSE, TRUE
          ),
          (
            'mail_delivery_release_receipt_delete_exact',
            pg_catalog.to_regprocedure(
              'public.enforce_mail_delivery_release_receipt_delete_exact()'
            )::pg_catalog.oid,
            9::pg_catalog.int2, TRUE, TRUE, TRUE, TRUE
          )
      ),
      actual_receipt_triggers AS (
        SELECT
          trigger_row.tgname::pg_catalog.text AS trigger_name,
          trigger_row.tgfoid AS function_oid,
          trigger_row.tgtype AS trigger_type,
          trigger_row.tgconstraint <> 0 AS is_constraint,
          trigger_row.tgdeferrable AS is_deferrable,
          trigger_row.tginitdeferred AS initially_deferred,
          (
            trigger_row.tgconstrrelid = 0
            AND trigger_row.tgconstrindid = 0
            AND trigger_row.tgparentid = 0
            AND trigger_row.tgqual IS NULL
            AND trigger_row.tgoldtable IS NULL
            AND trigger_row.tgnewtable IS NULL
            AND trigger_row.tgenabled = 'A'
            AND trigger_row.tgnargs = 0
            AND pg_catalog.octet_length(trigger_row.tgargs) = 0
            AND pg_catalog.cardinality(
              trigger_row.tgattr::pg_catalog.int2[]
            ) = 0
            AND CASE
              WHEN trigger_row.tgconstraint = 0
                THEN trigger_constraint.oid IS NULL
              ELSE
                trigger_constraint.oid = trigger_row.tgconstraint
                AND trigger_constraint.conrelid = relation.oid
                AND trigger_constraint.connamespace =
                      'public'::pg_catalog.regnamespace
                AND trigger_constraint.conname = trigger_row.tgname
                AND trigger_constraint.contype = 't'
                AND trigger_constraint.convalidated
                AND trigger_constraint.conislocal
                AND trigger_constraint.coninhcount = 0
                AND trigger_constraint.conparentid = 0
                AND trigger_constraint.condeferrable
                AND trigger_constraint.condeferred
            END
          ) AS exact_shape
        FROM receipt_relation AS relation
        JOIN pg_catalog.pg_trigger AS trigger_row
          ON trigger_row.tgrelid = relation.oid
         AND NOT trigger_row.tgisinternal
        LEFT JOIN pg_catalog.pg_constraint AS trigger_constraint
          ON trigger_constraint.oid = trigger_row.tgconstraint
      ),
      receipt_trigger_delta AS (
        SELECT * FROM (
          SELECT * FROM expected_receipt_triggers
          EXCEPT ALL
          SELECT * FROM actual_receipt_triggers
        ) AS missing_receipt_triggers
        UNION ALL
        SELECT * FROM (
          SELECT * FROM actual_receipt_triggers
          EXCEPT ALL
          SELECT * FROM expected_receipt_triggers
        ) AS unexpected_receipt_triggers
      ),
      receipt_triggers AS (
        SELECT NOT EXISTS (
          SELECT 1 FROM receipt_trigger_delta
        ) AS structure_exact
      ),
      receipt_relation_acl AS (
        SELECT
          pg_catalog.count(*) = 1
          AND COALESCE(pg_catalog.bool_and(
            COALESCE((
              SELECT pg_catalog.array_agg(
                pg_catalog.format(
                  '%s|%s|%s|%s',
                  CASE WHEN access.grantee = 0 THEN 'PUBLIC'
                       ELSE pg_catalog.pg_get_userbyid(access.grantee) END,
                  CASE WHEN access.grantor = 0 THEN 'PUBLIC'
                       ELSE pg_catalog.pg_get_userbyid(access.grantor) END,
                  pg_catalog.lower(access.privilege_type),
                  access.is_grantable::pg_catalog.text
                ) ORDER BY
                  CASE WHEN access.grantee = 0 THEN 'PUBLIC'
                       ELSE pg_catalog.pg_get_userbyid(access.grantee) END,
                  CASE WHEN access.grantor = 0 THEN 'PUBLIC'
                       ELSE pg_catalog.pg_get_userbyid(access.grantor) END,
                  pg_catalog.lower(access.privilege_type),
                  access.is_grantable
              )
              FROM pg_catalog.aclexplode(COALESCE(
                relation.relacl,
                pg_catalog.acldefault('r', relation.relowner)
              )) AS access
            ), ARRAY[]::pg_catalog.text[]) = ARRAY[
              'learncoding_owner|learncoding_owner|delete|false',
              'learncoding_owner|learncoding_owner|insert|false',
              'learncoding_owner|learncoding_owner|maintain|false',
              'learncoding_owner|learncoding_owner|references|false',
              'learncoding_owner|learncoding_owner|select|false',
              'learncoding_owner|learncoding_owner|trigger|false',
              'learncoding_owner|learncoding_owner|truncate|false',
              'learncoding_owner|learncoding_owner|update|false'
            ]::pg_catalog.text[]
            AND NOT EXISTS (
              SELECT 1
              FROM (VALUES
                ('learncoding_app'::pg_catalog.text),
                ('learncoding_worker'),
                ('learncoding_ops'),
                ('learncoding_backup_reporter')
              ) AS managed_receipt_principal(role_name)
              CROSS JOIN (VALUES
                ('SELECT'::pg_catalog.text), ('INSERT'), ('UPDATE'),
                ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'),
                ('MAINTAIN')
              ) AS managed_receipt_privilege(privilege_name)
              WHERE pg_catalog.has_table_privilege(
                pg_catalog.to_regrole(managed_receipt_principal.role_name),
                relation.oid,
                managed_receipt_privilege.privilege_name
              )
            )
            AND NOT pg_catalog.pg_has_role('learncoding_app', 'learncoding_owner', 'MEMBER')
            AND NOT pg_catalog.pg_has_role('learncoding_worker', 'learncoding_owner', 'MEMBER')
            AND NOT pg_catalog.pg_has_role('learncoding_ops', 'learncoding_owner', 'MEMBER')
            AND NOT pg_catalog.pg_has_role('learncoding_backup_reporter', 'learncoding_owner', 'MEMBER')
          ), FALSE) AS acl_exact
        FROM receipt_relation AS relation
      ),
      receipt_column_acl AS (
        SELECT
          pg_catalog.count(attribute.attnum) = 8
          AND COALESCE(pg_catalog.bool_and(
            COALESCE((
              SELECT pg_catalog.array_agg(
                pg_catalog.format(
                  '%s|%s|%s|%s',
                  CASE WHEN access.grantee = 0 THEN 'PUBLIC'
                       ELSE pg_catalog.pg_get_userbyid(access.grantee) END,
                  CASE WHEN access.grantor = 0 THEN 'PUBLIC'
                       ELSE pg_catalog.pg_get_userbyid(access.grantor) END,
                  pg_catalog.lower(access.privilege_type),
                  access.is_grantable::pg_catalog.text
                ) ORDER BY
                  CASE WHEN access.grantee = 0 THEN 'PUBLIC'
                       ELSE pg_catalog.pg_get_userbyid(access.grantee) END,
                  CASE WHEN access.grantor = 0 THEN 'PUBLIC'
                       ELSE pg_catalog.pg_get_userbyid(access.grantor) END,
                  pg_catalog.lower(access.privilege_type),
                  access.is_grantable
              )
              FROM pg_catalog.aclexplode(attribute.attacl) AS access
            ), ARRAY[]::pg_catalog.text[]) = CASE
              WHEN attribute.attnum BETWEEN 1 AND 7 THEN ARRAY[
                'learncoding_worker|learncoding_owner|select|false'
              ]::pg_catalog.text[]
              ELSE ARRAY[]::pg_catalog.text[]
            END
          ), FALSE) AS acl_exact
        FROM receipt_relation AS relation
        LEFT JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = relation.oid
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
      ),
      digest_helper AS (
        SELECT routine.*, language.lanname
          FROM pg_catalog.pg_proc AS routine
          JOIN pg_catalog.pg_language AS language
            ON language.oid = routine.prolang
         WHERE routine.oid = pg_catalog.to_regprocedure(
           'public.mail_delivery_release_receipt_sha256(uuid,uuid,text,text,text,text)'
         )
      ),
      digest_helper_catalog AS (
        SELECT
          pg_catalog.count(*) = 1
          AND COALESCE(pg_catalog.bool_and(
            pg_catalog.pg_get_userbyid(helper.proowner) =
              'learncoding_owner'
            AND helper.lanname = 'sql'
            AND helper.prokind = 'f'
            AND helper.prorettype =
              'pg_catalog.text'::pg_catalog.regtype
            AND NOT helper.proretset
            AND helper.provolatile = 'i'
            AND helper.prosecdef
            AND NOT helper.proleakproof
            AND helper.proisstrict
            AND helper.proparallel = 's'
            AND helper.proconfig = ARRAY[
              'search_path=pg_catalog, pg_temp'
            ]::pg_catalog.text[]
            AND helper.pronargs = 6
            AND helper.pronargdefaults = 0
            AND helper.proargdefaults IS NULL
            AND helper.proargnames = ARRAY[
              'input_outbox_id',
              'input_operation_id',
              'input_authority_version',
              'input_authority_sha256',
              'input_original_payload_sha256',
              'input_release_version'
            ]::pg_catalog.text[]
            AND ARRAY(
              SELECT input_type::pg_catalog.oid
                FROM pg_catalog.unnest(
                  helper.proargtypes
                ) AS input_type
            )::pg_catalog.oid[] = ARRAY[
              'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,
              'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,
              'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
              'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
              'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
              'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid
            ]::pg_catalog.oid[]
            AND helper.proallargtypes IS NULL
            AND helper.proargmodes IS NULL
            AND helper.protrftypes IS NULL
            AND helper.provariadic = 0
            AND helper.prosupport = 0
            AND helper.procost = 100
            AND helper.prorows = 0
            AND helper.probin IS NULL
            AND helper.prosqlbody IS NULL
            AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
              helper.prosrc, 'UTF8'
            )), 'hex') =
              '95169176e113b1a65fe08428dbec49e0b943b41a03867c3ed309141b3d011676'
            AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
              pg_catalog.pg_get_functiondef(helper.oid), 'UTF8'
            )), 'hex') =
              '63614be0762f14c3593ef05fc9f5f440a67a65bec27e703b59a18cd60273057d'
            AND (
              SELECT pg_catalog.count(*)
                FROM pg_catalog.pg_proc AS overload
               WHERE overload.pronamespace =
                       'public'::pg_catalog.regnamespace
                 AND overload.proname =
                       'mail_delivery_release_receipt_sha256'
            ) = 1
          ), FALSE) AS structure_exact,
          pg_catalog.count(*) = 1
          AND COALESCE(pg_catalog.bool_and(
            COALESCE((
              SELECT pg_catalog.array_agg(
                pg_catalog.format(
                  '%s|%s|%s|%s',
                  CASE WHEN access.grantee = 0 THEN 'PUBLIC'
                       ELSE pg_catalog.pg_get_userbyid(access.grantee) END,
                  CASE WHEN access.grantor = 0 THEN 'PUBLIC'
                       ELSE pg_catalog.pg_get_userbyid(access.grantor) END,
                  pg_catalog.lower(access.privilege_type),
                  access.is_grantable::pg_catalog.text
                ) ORDER BY
                  CASE WHEN access.grantee = 0 THEN 'PUBLIC'
                       ELSE pg_catalog.pg_get_userbyid(access.grantee) END,
                  CASE WHEN access.grantor = 0 THEN 'PUBLIC'
                       ELSE pg_catalog.pg_get_userbyid(access.grantor) END,
                  pg_catalog.lower(access.privilege_type),
                  access.is_grantable
              )
                FROM pg_catalog.aclexplode(COALESCE(
                  helper.proacl,
                  pg_catalog.acldefault('f', helper.proowner)
                )) AS access
            ), ARRAY[]::pg_catalog.text[]) = ARRAY[
              'learncoding_owner|learncoding_owner|execute|false',
              'learncoding_worker|learncoding_owner|execute|false'
            ]::pg_catalog.text[]
            AND pg_catalog.has_function_privilege(
              'learncoding_owner', helper.oid, 'EXECUTE'
            )
            AND pg_catalog.has_function_privilege(
              'learncoding_worker', helper.oid, 'EXECUTE'
            )
            AND NOT pg_catalog.has_function_privilege(
              'learncoding_app', helper.oid, 'EXECUTE'
            )
            AND NOT pg_catalog.has_function_privilege(
              'learncoding_ops', helper.oid, 'EXECUTE'
            )
            AND NOT pg_catalog.has_function_privilege(
              'learncoding_backup_reporter', helper.oid, 'EXECUTE'
            )
          ), FALSE) AS acl_exact
        FROM digest_helper AS helper
      ),
      issuer AS (
        SELECT routine.*, language.lanname, relation.reltype AS receipt_row_type
        FROM pg_catalog.pg_proc AS routine
        JOIN pg_catalog.pg_language AS language ON language.oid = routine.prolang
        LEFT JOIN receipt_relation AS relation ON TRUE
        WHERE routine.oid = pg_catalog.to_regprocedure(
          'public.release_email_outbox_delivery(uuid,uuid,text,text,text)'
        )
      ),
      issuer_catalog AS (
        SELECT
          pg_catalog.count(*) = 1
          AND COALESCE(pg_catalog.bool_and(
            pg_catalog.pg_get_userbyid(issuer.proowner) = 'learncoding_owner'
            AND issuer.lanname = 'plpgsql'
            AND issuer.prokind = 'f'
            AND issuer.prorettype = issuer.receipt_row_type
            AND NOT issuer.proretset
            AND issuer.provolatile = 'v'
            AND issuer.prosecdef
            AND NOT issuer.proleakproof
            AND NOT issuer.proisstrict
            AND issuer.proparallel = 'u'
            AND issuer.proconfig = ARRAY[
              'search_path=pg_catalog, pg_temp'
            ]::pg_catalog.text[]
            AND issuer.pronargs = 5
            AND issuer.pronargdefaults = 0
            AND issuer.proargdefaults IS NULL
            AND issuer.proallargtypes IS NULL
            AND issuer.proargmodes IS NULL
            AND issuer.protrftypes IS NULL
            AND issuer.provariadic = 0
            AND issuer.prosupport = 0
            AND issuer.procost = 100
            AND issuer.prorows = 0
            AND issuer.probin IS NULL
            AND issuer.prosqlbody IS NULL
            AND issuer.proargnames = ARRAY[
              'requested_outbox_id', 'requested_operation_id',
              'requested_authority_sha256',
              'requested_original_payload_sha256',
              'requested_release_version'
            ]::pg_catalog.text[]
            AND ARRAY(
              SELECT input_type::pg_catalog.oid
              FROM pg_catalog.unnest(issuer.proargtypes) AS input_type
            )::pg_catalog.oid[] = ARRAY[
              'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,
              'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,
              'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
              'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
              'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid
            ]::pg_catalog.oid[]
            AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
              issuer.prosrc, 'UTF8'
            )), 'hex') =
              'b90df49087aa1ca69e80fc18a4963d5fc724d91db8612b338c2d2b98f2a3db0f'
            AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
              pg_catalog.pg_get_functiondef(issuer.oid), 'UTF8'
            )), 'hex') =
              '9516f96ef9133bdf61f6db352422d521cf4616c6bd5b365888f1c614670ed409'
          ), FALSE) AS structure_exact,
          COALESCE(pg_catalog.bool_and(
            COALESCE((
              SELECT pg_catalog.array_agg(pg_catalog.format(
                '%s|%s|%s|%s',
                CASE WHEN access.grantee = 0 THEN 'PUBLIC'
                     ELSE pg_catalog.pg_get_userbyid(access.grantee) END,
                CASE WHEN access.grantor = 0 THEN 'PUBLIC'
                     ELSE pg_catalog.pg_get_userbyid(access.grantor) END,
                pg_catalog.lower(access.privilege_type),
                access.is_grantable::pg_catalog.text
              ) ORDER BY
                CASE WHEN access.grantee = 0 THEN 'PUBLIC'
                     ELSE pg_catalog.pg_get_userbyid(access.grantee) END,
                CASE WHEN access.grantor = 0 THEN 'PUBLIC'
                     ELSE pg_catalog.pg_get_userbyid(access.grantor) END,
                pg_catalog.lower(access.privilege_type),
                access.is_grantable
              )
              FROM pg_catalog.aclexplode(COALESCE(
                issuer.proacl, pg_catalog.acldefault('f', issuer.proowner)
              )) AS access
            ), ARRAY[]::pg_catalog.text[]) = ARRAY[
              'learncoding_app|learncoding_owner|execute|false',
              'learncoding_owner|learncoding_owner|execute|false',
              'learncoding_worker|learncoding_owner|execute|false'
            ]::pg_catalog.text[]
            AND pg_catalog.has_function_privilege(
              'learncoding_app', issuer.oid, 'EXECUTE'
            )
            AND pg_catalog.has_function_privilege(
              'learncoding_owner', issuer.oid, 'EXECUTE'
            )
            AND pg_catalog.has_function_privilege(
              'learncoding_worker', issuer.oid, 'EXECUTE'
            )
            AND NOT pg_catalog.has_function_privilege(
              'learncoding_ops', issuer.oid, 'EXECUTE'
            )
            AND NOT pg_catalog.has_function_privilege(
              'learncoding_migrator', issuer.oid, 'EXECUTE'
            )
            AND NOT pg_catalog.has_function_privilege(
              'learncoding_backup_reporter', issuer.oid, 'EXECUTE'
            )
            AND pg_catalog.has_function_privilege(
              'learncoding_backup_reporter',
              'public.enqueue_backup_status_mail_authority(text,text)',
              'EXECUTE'
            )
          ), FALSE) AS acl_exact
        FROM issuer
      ),
      verifier AS (
        SELECT routine.*, language.lanname
        FROM pg_catalog.pg_proc AS routine
        JOIN pg_catalog.pg_language AS language ON language.oid = routine.prolang
        WHERE routine.oid = pg_catalog.to_regprocedure(
          'public.verify_email_outbox_delivery_release(uuid,uuid,text,text,text)'
        )
      ),
      verifier_catalog AS (
        SELECT
          pg_catalog.count(*) = 1
          AND COALESCE(pg_catalog.bool_and(
            pg_catalog.pg_get_userbyid(verifier.proowner) = 'learncoding_owner'
            AND verifier.lanname = 'plpgsql'
            AND verifier.prokind = 'f'
            AND verifier.prorettype = 'pg_catalog.record'::pg_catalog.regtype
            AND verifier.proretset
            AND verifier.provolatile = 'v'
            AND verifier.prosecdef
            AND NOT verifier.proleakproof
            AND NOT verifier.proisstrict
            AND verifier.proparallel = 'u'
            AND verifier.proconfig = ARRAY[
              'search_path=pg_catalog, pg_temp'
            ]::pg_catalog.text[]
            AND verifier.pronargs = 5
            AND verifier.pronargdefaults = 0
            AND verifier.proargdefaults IS NULL
            AND verifier.proargnames = ARRAY[
              'requested_outbox_id', 'requested_operation_id',
              'requested_authority_sha256',
              'requested_original_payload_sha256',
              'requested_release_version',
              'outbox_id', 'operation_id'
            ]::pg_catalog.text[]
            AND verifier.proallargtypes = ARRAY[
              'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,
              'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,
              'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
              'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
              'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
              'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,
              'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid
            ]::pg_catalog.oid[]
            AND ARRAY(
              SELECT argument_mode::pg_catalog.text
              FROM pg_catalog.unnest(verifier.proargmodes) AS argument_mode
            )::pg_catalog.text[] = ARRAY[
              'i', 'i', 'i', 'i', 'i', 't', 't'
            ]::pg_catalog.text[]
            AND ARRAY(
              SELECT input_type::pg_catalog.oid
              FROM pg_catalog.unnest(verifier.proargtypes) AS input_type
            )::pg_catalog.oid[] = ARRAY[
              'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,
              'pg_catalog.uuid'::pg_catalog.regtype::pg_catalog.oid,
              'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
              'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid,
              'pg_catalog.text'::pg_catalog.regtype::pg_catalog.oid
            ]::pg_catalog.oid[]
            AND verifier.protrftypes IS NULL
            AND verifier.provariadic = 0
            AND verifier.prosupport = 0
            AND verifier.procost = 100
            AND verifier.prorows = 1000
            AND verifier.probin IS NULL
            AND verifier.prosqlbody IS NULL
            AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
              verifier.prosrc, 'UTF8'
            )), 'hex') =
              'b3277feeb2ed099406e17a3fe548bae580f978f5cd94a7f55f28687c81d9042c'
            AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
              pg_catalog.pg_get_functiondef(verifier.oid), 'UTF8'
            )), 'hex') =
              '8e50e51aae34e3657a6a2d9d90fc546025512f2678b083e824a5cc0f8457ee5f'
          ), FALSE) AS structure_exact,
          COALESCE(pg_catalog.bool_and(
            COALESCE((
              SELECT pg_catalog.array_agg(pg_catalog.format(
                '%s|%s|%s|%s',
                CASE WHEN access.grantee = 0 THEN 'PUBLIC'
                     ELSE pg_catalog.pg_get_userbyid(access.grantee) END,
                CASE WHEN access.grantor = 0 THEN 'PUBLIC'
                     ELSE pg_catalog.pg_get_userbyid(access.grantor) END,
                pg_catalog.lower(access.privilege_type),
                access.is_grantable::pg_catalog.text
              ) ORDER BY
                CASE WHEN access.grantee = 0 THEN 'PUBLIC'
                     ELSE pg_catalog.pg_get_userbyid(access.grantee) END,
                CASE WHEN access.grantor = 0 THEN 'PUBLIC'
                     ELSE pg_catalog.pg_get_userbyid(access.grantor) END,
                pg_catalog.lower(access.privilege_type),
                access.is_grantable
              )
              FROM pg_catalog.aclexplode(COALESCE(
                verifier.proacl,
                pg_catalog.acldefault('f', verifier.proowner)
              )) AS access
            ), ARRAY[]::pg_catalog.text[]) = ARRAY[
              'learncoding_app|learncoding_owner|execute|false',
              'learncoding_owner|learncoding_owner|execute|false'
            ]::pg_catalog.text[]
            AND pg_catalog.has_function_privilege(
              'learncoding_app', verifier.oid, 'EXECUTE'
            )
            AND pg_catalog.has_function_privilege(
              'learncoding_owner', verifier.oid, 'EXECUTE'
            )
            AND NOT pg_catalog.has_function_privilege(
              'learncoding_worker', verifier.oid, 'EXECUTE'
            )
            AND NOT pg_catalog.has_function_privilege(
              'learncoding_migrator', verifier.oid, 'EXECUTE'
            )
            AND NOT pg_catalog.has_function_privilege(
              'learncoding_ops', verifier.oid, 'EXECUTE'
            )
            AND NOT pg_catalog.has_function_privilege(
              'learncoding_backup_reporter', verifier.oid, 'EXECUTE'
            )
          ), FALSE) AS acl_exact
        FROM verifier
      ),
      outbox_runtime_catalog AS (
        SELECT
          pg_catalog.count(attribute.attnum) = 5
          AND COALESCE(pg_catalog.bool_and((
            attribute.atttypmod = -1
            AND attribute.attidentity = ''
            AND attribute.attgenerated = ''
            AND NOT attribute.atthasdef
            AND NOT attribute.atthasmissing
            AND attribute.attmissingval IS NULL
            AND attribute.attislocal
            AND attribute.attinhcount = 0
            AND CASE attribute.attnum
              WHEN 33 THEN attribute.attname = 'delivery_hold_version'
                AND attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
                AND attribute.attnotnull
              WHEN 34 THEN attribute.attname = 'delivery_release_insert_xid'
                AND attribute.atttypid = 'pg_catalog.xid8'::pg_catalog.regtype
                AND NOT attribute.attnotnull
              WHEN 35 THEN attribute.attname = 'provider_request_body_sha256'
                AND attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
                AND NOT attribute.attnotnull
              WHEN 36 THEN attribute.attname = 'provider_request_body_length'
                AND attribute.atttypid = 'pg_catalog.int8'::pg_catalog.regtype
                AND NOT attribute.attnotnull
              WHEN 37 THEN attribute.attname = 'delivery_release_insert_system_identifier'
                AND attribute.atttypid = 'pg_catalog.int8'::pg_catalog.regtype
                AND NOT attribute.attnotnull
              ELSE FALSE
            END
          ) IS TRUE), FALSE) AS structure_exact,
          COALESCE(pg_catalog.bool_and(
            COALESCE((
              SELECT pg_catalog.array_agg(pg_catalog.format(
                '%s|%s|%s|%s',
                CASE WHEN access.grantee = 0 THEN 'PUBLIC'
                     ELSE pg_catalog.pg_get_userbyid(access.grantee) END,
                CASE WHEN access.grantor = 0 THEN 'PUBLIC'
                     ELSE pg_catalog.pg_get_userbyid(access.grantor) END,
                pg_catalog.lower(access.privilege_type),
                access.is_grantable::pg_catalog.text
              ) ORDER BY
                CASE WHEN access.grantee = 0 THEN 'PUBLIC'
                     ELSE pg_catalog.pg_get_userbyid(access.grantee) END,
                CASE WHEN access.grantor = 0 THEN 'PUBLIC'
                     ELSE pg_catalog.pg_get_userbyid(access.grantor) END,
                pg_catalog.lower(access.privilege_type),
                access.is_grantable
              )
              FROM pg_catalog.aclexplode(attribute.attacl) AS access
            ), ARRAY[]::pg_catalog.text[]) = CASE
              WHEN attribute.attname IN (
                'provider_request_body_sha256',
                'provider_request_body_length'
              ) THEN ARRAY[
                'learncoding_worker|learncoding_owner|update|false'
              ]::pg_catalog.text[]
              ELSE ARRAY[]::pg_catalog.text[]
            END
            AND pg_catalog.has_table_privilege(
            'learncoding_worker', relation.oid, 'SELECT'
          )
          AND pg_catalog.has_column_privilege(
            'learncoding_worker', relation.oid,
            'provider_request_body_sha256', 'UPDATE'
          )
          AND pg_catalog.has_column_privilege(
            'learncoding_worker', relation.oid,
            'provider_request_body_length', 'UPDATE'
          )
          AND NOT pg_catalog.has_column_privilege(
            'learncoding_worker', relation.oid,
            'delivery_release_insert_xid', 'UPDATE'
          )
          AND NOT pg_catalog.has_column_privilege(
            'learncoding_worker', relation.oid,
            'delivery_release_insert_system_identifier', 'UPDATE'
          )), FALSE) AS acl_exact
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        LEFT JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = relation.oid
         AND attribute.attnum BETWEEN 33 AND 37
         AND NOT attribute.attisdropped
        WHERE namespace.nspname = 'public'
          AND relation.relname = 'email_outbox'
      )
      SELECT
        CASE
          WHEN lineage.phase_0067_count = 1
            OR lineage.lineage_window_count > 1
            OR hold.footprint_count > 0
            THEN TRUE
          WHEN lineage.phase_0066_count = 1
            AND lineage.lineage_window_count = 1
            AND hold.footprint_count = 0
            THEN FALSE
          ELSE NULL
        END AS hold_catalog_present,
        CASE
          WHEN lineage.phase_0067_count = 1
            AND hold.footprint_count = 1
            AND hold.structure_exact
            THEN TRUE
          WHEN lineage.phase_0066_count = 1
            AND lineage.lineage_window_count = 1
            AND hold.footprint_count = 0
            THEN FALSE
          ELSE NULL
        END AS hold_catalog_exact,
        (
          lineage.phase_0066_count = 1
          AND lineage.phase_0067_count = 1
          AND lineage.phase_0068_count = 1
          AND lineage.phase_0069_count = 1
          AND lineage.candidate_hash_count = 1
          AND lineage.lineage_window_count = 4
          AND lineage_attestor_catalog.structure_exact
          AND lineage_attestor_catalog.acl_exact
          AND hold.footprint_count = 1
          AND hold.structure_exact
          AND receipt_relation_catalog.structure_exact
          AND receipt_columns.structure_exact
          AND receipt_default.structure_exact
          AND receipt_not_null_constraints.structure_exact
          AND receipt_constraints.structure_exact
          AND receipt_triggers.structure_exact
          AND receipt_relation_acl.acl_exact
          AND receipt_column_acl.acl_exact
          AND digest_helper_catalog.structure_exact
          AND digest_helper_catalog.acl_exact
          AND issuer_catalog.structure_exact
          AND issuer_catalog.acl_exact
          AND verifier_catalog.structure_exact
          AND verifier_catalog.acl_exact
          AND outbox_runtime_catalog.structure_exact
          AND outbox_runtime_catalog.acl_exact
        ) AS delivery_release_capability_exact
      FROM hold_column AS hold
      CROSS JOIN migration_lineage AS lineage
      CROSS JOIN lineage_attestor_catalog
      CROSS JOIN receipt_relation_catalog
      CROSS JOIN receipt_columns
      CROSS JOIN receipt_default
      CROSS JOIN receipt_not_null_constraints
      CROSS JOIN receipt_constraints
      CROSS JOIN receipt_triggers
      CROSS JOIN receipt_relation_acl
      CROSS JOIN receipt_column_acl
      CROSS JOIN digest_helper_catalog
      CROSS JOIN issuer_catalog
      CROSS JOIN verifier_catalog
      CROSS JOIN outbox_runtime_catalog
    `);
    if (result.rows.length !== 1) {
      throw new MailDeliveryAuthorityRuntimeError();
    }
    return parseDeliveryAuthorityRuntimeRow(
      result.rows[0] as DeliveryAuthorityRuntimeRow | undefined,
    );
  } catch {
    throw new MailDeliveryAuthorityRuntimeError();
  }
}
export const MAIL_DISPATCH_PRODUCTION_CONCURRENCY =
  MAIL_DISPATCH_RUNTIME_BOOTSTRAP.productionConcurrency;
export const MAIL_DISPATCH_OTHER_PROCESS_POOL_MAXIMUM_CONNECTIONS =
  MAIL_DISPATCH_RUNTIME_BOOTSTRAP.otherProcessPoolMaximumConnections;

type StartupSnapshotRow = Readonly<{
  max_connections?: unknown;
  admin_reserved_connections?: unknown;
  server_version_num?: unknown;
}>;

export type MailDispatchStartupPool = Readonly<{
  options?: Readonly<{
    max?: unknown;
    connectionTimeoutMillis?: unknown;
    idleTimeoutMillis?: unknown;
  }>;
  connect(): Promise<MailDispatchDbClient>;
}>;

export type MailDispatchRuntimeStartupInspection = Readonly<{
  plan: MailDispatchRuntimePlan;
  postgresMajor: number;
}>;

const issuedInspections = new WeakSet<object>();
const issuedPlanPostgresMajors = new WeakMap<object, number>();
const issuedInspectionPools = new WeakMap<object, MailDispatchStartupPool>();
const issuedPlanPools = new WeakMap<object, MailDispatchStartupPool>();

function integerText(
  value: unknown,
  input: Readonly<{ allowZero: boolean }>,
): number | null {
  const pattern = input.allowZero ? /^(?:0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/;
  if (typeof value !== "string" || !pattern.test(value)) {
    return null;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function hasExactPoolOptions(pool: MailDispatchStartupPool): boolean {
  try {
    return (
      pool.options?.max ===
        MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolMaximumConnections &&
      pool.options.connectionTimeoutMillis ===
        MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolAcquireTimeoutMs &&
      pool.options.idleTimeoutMillis ===
        MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolIdleTimeoutMs
    );
  } catch {
    return false;
  }
}

/**
 * Recognizes only the exact frozen inspection returned by this module.
 * Reconstructed objects and policy-factory plans carry no live startup proof.
 */
export function isMailDispatchRuntimeStartupInspection(
  value: unknown,
): value is MailDispatchRuntimeStartupInspection {
  if (
    value === null ||
    typeof value !== "object" ||
    !issuedInspections.has(value)
  ) {
    return false;
  }

  const inspection = value as MailDispatchRuntimeStartupInspection;
  return (
    Object.isFrozen(inspection) &&
    isMailDispatchRuntimePlan(inspection.plan) &&
    issuedPlanPostgresMajors.get(inspection.plan) === inspection.postgresMajor
  );
}

/**
 * Binds an issued inspection and its plan to the exact inspected pool identity.
 */
export function isMailDispatchRuntimeStartupInspectionForPool(
  value: unknown,
  pool: object,
): value is MailDispatchRuntimeStartupInspection {
  if (!isMailDispatchRuntimeStartupInspection(value)) {
    return false;
  }

  return (
    issuedInspectionPools.get(value) === pool &&
    issuedPlanPools.get(value.plan) === pool
  );
}

/**
 * Inspects the exact production mail pool and one live PostgreSQL snapshot.
 * The opaque result is the pool-bound runtime capability consumed by storage.
 */
export async function inspectMailDispatchRuntime(
  pool: MailDispatchStartupPool,
): Promise<MailDispatchRuntimeStartupInspection> {
  if (pool === null || typeof pool !== "object" || !hasExactPoolOptions(pool)) {
    throw new Error("Mail dispatch startup pool configuration is invalid.");
  }

  const deadline = createMailDispatchDbDeadline({
    phase: "pool-acquire",
    budgetMs: MAIL_DISPATCH_RUNTIME_DEFAULTS.queryTimeoutMs,
  });
  let lease: MailDispatchDbClientLease<MailDispatchDbClient>;
  try {
    lease = await connectMailDispatchDbWithin({ pool, deadline });
  } catch {
    throw new Error("Mail dispatch startup database inspection failed.");
  }

  let stage:
    | "bootstrap"
    | "snapshot-query"
    | "snapshot-validation"
    | "authority"
    | "plan"
    | "commit"
    | "release" = "bootstrap";
  let transactionStarted = false;
  let transactionFinished = false;
  let cleanupFailed = false;

  const query = (text: string) =>
    queryMailDispatchDbWithin({ lease, deadline, text });

  try {
    await query(`
      BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
      SET LOCAL search_path = pg_catalog, pg_temp;
      SET LOCAL quote_all_identifiers = false;
      SET LOCAL statement_timeout = '${MAIL_DISPATCH_RUNTIME_DEFAULTS.queryTimeoutMs}ms';
      SET LOCAL idle_in_transaction_session_timeout = '${MAIL_DISPATCH_RUNTIME_DEFAULTS.queryTimeoutMs}ms';
      SET LOCAL transaction_timeout = '${MAIL_DISPATCH_RUNTIME_DEFAULTS.queryTimeoutMs}ms';
    `);
    transactionStarted = true;

    stage = "snapshot-query";
    const result = await query(`
      select current_setting('max_connections') as max_connections,
             (
               current_setting('superuser_reserved_connections')::integer
               + coalesce(
                   nullif(
                     current_setting('reserved_connections', true),
                     ''
                   )::integer,
                   0
                 )
             )::text as admin_reserved_connections,
             current_setting('server_version_num') as server_version_num
    `);
    stage = "snapshot-validation";

    if (!Array.isArray(result.rows) || result.rows.length !== 1) {
      throw new Error("PostgreSQL startup snapshot is invalid.");
    }

    const row = result.rows[0] as StartupSnapshotRow | undefined;
    const serverMaximumConnections = integerText(row?.max_connections, {
      allowZero: false,
    });
    const serverAdminReserveConnections = integerText(
      row?.admin_reserved_connections,
      { allowZero: true },
    );
    const serverVersionNumber = integerText(row?.server_version_num, {
      allowZero: false,
    });
    if (
      serverMaximumConnections === null ||
      serverAdminReserveConnections === null ||
      serverVersionNumber === null
    ) {
      throw new Error("PostgreSQL startup snapshot is invalid.");
    }

    const postgresMajor = Math.floor(serverVersionNumber / 10_000);
    if (postgresMajor < MINIMUM_MAIL_DISPATCH_POSTGRES_MAJOR) {
      throw new Error("Mail dispatch requires PostgreSQL 17 or newer.");
    }

    stage = "authority";
    const deliveryAuthority = await requireMailDeliveryAuthorityRuntime({
      query: async (queryText) => query(queryText),
    });
    if (
      !deliveryAuthority.holdCatalogExact ||
      !deliveryAuthority.deliveryReleaseCapabilityExact
    ) {
      throw new MailDeliveryAuthorityRuntimeError();
    }

    stage = "plan";
    const plan = planMailDispatchRuntime({
      concurrency: MAIL_DISPATCH_PRODUCTION_CONCURRENCY,
      poolMaximumConnections:
        MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolMaximumConnections,
      serverMaximumConnections,
      serverAdminReserveConnections,
      otherProcessPoolMaximumConnections:
        MAIL_DISPATCH_OTHER_PROCESS_POOL_MAXIMUM_CONNECTIONS,
      poolAcquireTimeoutMs: MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolAcquireTimeoutMs,
      poolIdleTimeoutMs: MAIL_DISPATCH_RUNTIME_BOOTSTRAP.poolIdleTimeoutMs,
    });
    const inspection = Object.freeze({
      plan,
      postgresMajor,
    });

    stage = "commit";
    await query("COMMIT");
    transactionFinished = true;
    stage = "release";
    lease.release();

    issuedPlanPostgresMajors.set(plan, postgresMajor);
    issuedPlanPools.set(plan, pool);
    issuedInspections.add(inspection);
    issuedInspectionPools.set(inspection, pool);
    return inspection;
  } catch (error) {
    if (
      !lease.isReleased &&
      transactionStarted &&
      !transactionFinished &&
      !deadline.isExpired()
    ) {
      try {
        await queryMailDispatchDbWithin({
          lease,
          deadline,
          text: "ROLLBACK",
        });
        transactionFinished = true;
      } catch {
        cleanupFailed = true;
      }
    }

    if (!lease.isReleased) {
      try {
        if (cleanupFailed || !transactionFinished) {
          lease.destroy();
        } else {
          lease.release();
        }
      } catch {
        cleanupFailed = true;
      }
    }

    if (cleanupFailed) {
      throw new Error("Mail dispatch startup database inspection failed.");
    }
    if (error instanceof MailDeliveryAuthorityRuntimeError) {
      throw error;
    }
    if (stage === "snapshot-validation" || stage === "plan") {
      throw error;
    }
    throw new Error("Mail dispatch startup database inspection failed.");
  }
}
