import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  readdir,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "pg";

import {
  openCredential,
  parseMasterKey,
  type CredentialContext,
  type SealedCredential,
} from "../src/lib/security/credential-vault";

interface QueryResultLike {
  rows: Array<Record<string, unknown>>;
}

export interface QueryClientLike {
  query(sql: string): Promise<QueryResultLike>;
}

const requiredApplicationRelations = [
  "drizzle.__drizzle_migrations",
  "public.\"user\"",
  "public.course",
  "public.lesson",
  "public.enrollment",
] as const;
const requiredMailAuthorityRelations = [
  "public.email_outbox",
  "public.email_outbox_idempotency_authority",
  "public.backup_status_mail_authority",
  "public.mail_delivery_release_receipt",
] as const;
const requiredRestoreRelations = [
  ...requiredApplicationRelations,
  ...requiredMailAuthorityRelations,
] as const;
const requiredPublicTableCount = requiredRestoreRelations.length - 1;

type ReviewedMigrationLedgerModule = Readonly<{
  REVIEWED_MIGRATION_LEDGER: readonly Readonly<{
    idx: number;
    when: number;
    tag: string;
    sqlSha256: string;
  }>[];
  REVIEWED_MIGRATION_LEDGER_SHA256: string;
  verifyAppliedMigrationLedger: (
    client: QueryClientLike,
    options: Readonly<{ requireComplete: boolean }>,
  ) => Promise<Readonly<{
    appliedCount: number;
    complete: boolean;
    ledgerSha256: string;
  }>>;
}>;

export const RESTORE_DATABASE_CLIENT_TIMEOUTS = Object.freeze({
  connectMs: 5_000,
  queryMs: 30_000,
  statementMs: 25_000,
  idleInTransactionMs: 25_000,
  closeMs: 5_000,
});

type RestoreDatabaseClientLike = QueryClientLike & {
  connect(): Promise<unknown>;
  end(): Promise<void>;
  connection?: {
    stream?: {
      destroy(error?: Error): void;
    };
  };
};

type RestoreDatabaseClientLifecycleBounds = Readonly<{
  connectMs: number;
  closeMs: number;
}>;

const NO_RESTORE_DATABASE_FAILURE = Symbol("no restore database failure");
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REVIEWED_MIGRATION_LEDGER_MODULE_URL = pathToFileURL(path.join(
  SCRIPT_DIRECTORY,
  "lib",
  "reviewed-migration-ledger.mjs",
)).href;

function requirePositiveFiniteMilliseconds(value: number, label: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be positive and finite`);
  }
  return value;
}

export function restoreDatabaseClientConfig(connectionString: string) {
  if (typeof connectionString !== "string" || connectionString.length === 0) {
    throw new Error("restore database URL is required");
  }
  return {
    connectionString,
    connectionTimeoutMillis: RESTORE_DATABASE_CLIENT_TIMEOUTS.connectMs,
    query_timeout: RESTORE_DATABASE_CLIENT_TIMEOUTS.queryMs,
    statement_timeout: RESTORE_DATABASE_CLIENT_TIMEOUTS.statementMs,
    idle_in_transaction_session_timeout:
      RESTORE_DATABASE_CLIENT_TIMEOUTS.idleInTransactionMs,
    application_name: "codestead-restore-verifier",
  } as const;
}

function preserveRestoreFailureWithCleanupCause(
  primaryFailure: unknown,
  cleanupFailures: readonly unknown[],
) {
  const combinedFailures = [primaryFailure, ...cleanupFailures];
  const combined = new AggregateError(
    combinedFailures,
    "restore database operation failed and cleanup was incomplete",
    { cause: primaryFailure },
  );
  if (primaryFailure instanceof Error) {
    try {
      const cleanupCause = "cause" in primaryFailure
        ? new AggregateError(
            cleanupFailures,
            "restore database operation failed and cleanup was incomplete",
            { cause: primaryFailure.cause },
          )
        : new AggregateError(
            cleanupFailures,
            "restore database operation failed and cleanup was incomplete",
          );
      Object.defineProperty(primaryFailure, "cause", {
        value: cleanupCause,
        configurable: true,
        writable: true,
        enumerable: false,
      });
      return primaryFailure;
    } catch {
      return combined;
    }
  }
  return combined;
}

async function boundedRestoreDatabaseClientPhase<T>(
  client: RestoreDatabaseClientLike,
  phase: "connect" | "close",
  operation: Promise<T>,
  timeoutMs: number,
) {
  requirePositiveFiniteMilliseconds(timeoutMs, `${phase} timeout`);
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const observedOperation = Promise.resolve(operation);
  void observedOperation.catch(() => undefined);
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      const timeoutError = new Error(
        `restore database client ${phase} timeout`,
      );
      try {
        client.connection?.stream?.destroy(timeoutError);
      } catch (destroyError) {
        Object.defineProperty(timeoutError, "cause", {
          value: destroyError,
          configurable: true,
          writable: true,
          enumerable: false,
        });
      }
      reject(timeoutError);
    }, timeoutMs);
  });
  try {
    return await Promise.race([observedOperation, timeout]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

export async function runRestoreDatabaseClientOperation<T>(
  client: RestoreDatabaseClientLike,
  operation: (client: QueryClientLike) => Promise<T>,
  bounds: RestoreDatabaseClientLifecycleBounds = {
    connectMs: RESTORE_DATABASE_CLIENT_TIMEOUTS.connectMs,
    closeMs: RESTORE_DATABASE_CLIENT_TIMEOUTS.closeMs,
  },
) {
  const connectMs = requirePositiveFiniteMilliseconds(
    bounds.connectMs,
    "connect timeout",
  );
  const closeMs = requirePositiveFiniteMilliseconds(
    bounds.closeMs,
    "close timeout",
  );
  let primaryFailure: unknown = NO_RESTORE_DATABASE_FAILURE;
  let cleanupFailure: unknown = NO_RESTORE_DATABASE_FAILURE;
  let result!: T;
  try {
    await boundedRestoreDatabaseClientPhase(
      client,
      "connect",
      Promise.resolve().then(() => client.connect()),
      connectMs,
    );
    result = await operation(client);
  } catch (error) {
    primaryFailure = error;
  }
  try {
    await boundedRestoreDatabaseClientPhase(
      client,
      "close",
      Promise.resolve().then(() => client.end()),
      closeMs,
    );
  } catch (error) {
    cleanupFailure = error;
  }
  if (primaryFailure !== NO_RESTORE_DATABASE_FAILURE) {
    if (cleanupFailure !== NO_RESTORE_DATABASE_FAILURE) {
      throw preserveRestoreFailureWithCleanupCause(
        primaryFailure,
        [cleanupFailure],
      );
    }
    throw primaryFailure;
  }
  if (cleanupFailure !== NO_RESTORE_DATABASE_FAILURE) throw cleanupFailure;
  return result;
}

export async function runWithRestoreDatabaseClient<T>(
  connectionString: string,
  operation: (client: QueryClientLike) => Promise<T>,
  createClient: (
    config: ReturnType<typeof restoreDatabaseClientConfig>,
  ) => RestoreDatabaseClientLike = (config) =>
    new Client(config) as RestoreDatabaseClientLike,
) {
  const client = createClient(restoreDatabaseClientConfig(connectionString));
  return runRestoreDatabaseClientOperation(client, operation);
}

const RESTORE_LEDGER_DEFINER_ROLE = "learncoding_restore_ledger_reader";
const RESTORE_LEDGER_AUDIT_SCHEMA = "codestead_restore_audit";
const RESTORE_LEDGER_AUTHORITY_SIGNATURE =
  "codestead_restore_audit.reviewed_migration_ledger()";

export const RESTORE_LEDGER_AUTHORITY_BODY = `
BEGIN
  IF session_user IS DISTINCT FROM 'learncoding_ops'
     OR current_user IS DISTINCT FROM 'learncoding_restore_ledger_reader' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'restore migration ledger authority denied';
  END IF;

  RETURN QUERY
  SELECT journal.id::text,
         journal.hash::text,
         journal.created_at::text
    FROM drizzle.__drizzle_migrations AS journal
   ORDER BY journal.id;
END;
`;

const RESTORE_LEDGER_AUTHORITY_BODY_SHA256 = createHash("sha256")
  .update(RESTORE_LEDGER_AUTHORITY_BODY, "utf8")
  .digest("hex");
function requireAbsolute(value: string, label: string) {
  if (!path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new Error(`${label} must be an absolute canonical path`);
  }
  return value;
}

async function readSecureRegularFile(filePath: string, expectedMode = 0o600) {
  requireAbsolute(filePath, "protected file");
  const parent = path.dirname(filePath);
  if ((await realpath(parent)) !== parent) throw new Error("protected file parent is unsafe");
  const noFollow = process.platform === "linux" ? (constants.O_NOFOLLOW ?? 0) : 0;
  const handle = await open(filePath, constants.O_RDONLY | noFollow);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("protected path is not a regular file");
    if (process.platform === "linux") {
      const uid = process.getuid?.();
      if (uid === undefined || metadata.uid !== uid || (metadata.mode & 0o7777) !== expectedMode) {
        throw new Error("protected file metadata is unsafe");
      }
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function exactObject(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

async function loadReviewedMigrationLedger() {
  let reviewed: ReviewedMigrationLedgerModule;
  try {
    reviewed = await import(
      REVIEWED_MIGRATION_LEDGER_MODULE_URL
    ) as ReviewedMigrationLedgerModule;
  } catch {
    throw new Error("restore migration ledger contract is unavailable");
  }

  const tail = reviewed.REVIEWED_MIGRATION_LEDGER.at(-1);
  if (
    reviewed.REVIEWED_MIGRATION_LEDGER.length !== 70
    || tail?.idx !== 69
    || tail.tag !== "0069_mail_outbox_guarded_delivery_authority"
    || !/^[0-9a-f]{64}$/.test(reviewed.REVIEWED_MIGRATION_LEDGER_SHA256)
    || typeof reviewed.verifyAppliedMigrationLedger !== "function"
  ) {
    throw new Error("restore migration ledger contract is not the reviewed 0069 contract");
  }
  return reviewed;
}

function restoreLedgerAuthorityCatalogQuery() {
  return `
    WITH definer_role AS (
      SELECT role.*
        FROM pg_catalog.pg_roles AS role
       WHERE role.rolname = '${RESTORE_LEDGER_DEFINER_ROLE}'
    ), audit_schema AS (
      SELECT namespace.*
        FROM pg_catalog.pg_namespace AS namespace
       WHERE namespace.nspname = '${RESTORE_LEDGER_AUDIT_SCHEMA}'
    ), drizzle_schema AS (
      SELECT namespace.*
        FROM pg_catalog.pg_namespace AS namespace
       WHERE namespace.nspname = 'drizzle'
    ), ledger AS (
      SELECT relation.*
        FROM pg_catalog.pg_class AS relation
        JOIN drizzle_schema
          ON drizzle_schema.oid = relation.relnamespace
       WHERE relation.relname = '__drizzle_migrations'
         AND relation.relkind IN ('r', 'p')
    ), target AS (
      SELECT routine.*,
             owner.rolname::text AS owner_name,
             language.lanname::text AS language_name
        FROM pg_catalog.pg_proc AS routine
        JOIN pg_catalog.pg_roles AS owner
          ON owner.oid = routine.proowner
        JOIN pg_catalog.pg_language AS language
          ON language.oid = routine.prolang
       WHERE routine.oid = pg_catalog.to_regprocedure(
               '${RESTORE_LEDGER_AUTHORITY_SIGNATURE}'
             )
    ), current_database_row AS (
      SELECT database_object.oid
        FROM pg_catalog.pg_database AS database_object
       WHERE database_object.datname = pg_catalog.current_database()
    ), observed_definer_dependencies AS (
      SELECT dependency.dbid,
             dependency.classid,
             dependency.objid,
             dependency.objsubid,
             dependency.refclassid,
             dependency.refobjid,
             dependency.deptype
        FROM pg_catalog.pg_shdepend AS dependency
        CROSS JOIN definer_role
       WHERE dependency.refclassid =
               'pg_catalog.pg_authid'::pg_catalog.regclass
         AND dependency.refobjid = definer_role.oid
    ), expected_definer_dependencies AS (
      SELECT current_database_row.oid AS dbid,
             'pg_catalog.pg_proc'::pg_catalog.regclass AS classid,
             target.oid AS objid,
             0::pg_catalog.int4 AS objsubid,
             'pg_catalog.pg_authid'::pg_catalog.regclass AS refclassid,
             definer_role.oid AS refobjid,
             'o'::"char" AS deptype
        FROM current_database_row
        CROSS JOIN target
        CROSS JOIN definer_role
      UNION ALL
      SELECT current_database_row.oid,
             'pg_catalog.pg_class'::pg_catalog.regclass,
             ledger.oid,
             0::pg_catalog.int4,
             'pg_catalog.pg_authid'::pg_catalog.regclass,
             definer_role.oid,
             'a'::"char"
        FROM current_database_row
        CROSS JOIN ledger
        CROSS JOIN definer_role
      UNION ALL
      SELECT current_database_row.oid,
             'pg_catalog.pg_namespace'::pg_catalog.regclass,
             drizzle_schema.oid,
             0::pg_catalog.int4,
             'pg_catalog.pg_authid'::pg_catalog.regclass,
             definer_role.oid,
             'a'::"char"
        FROM current_database_row
        CROSS JOIN drizzle_schema
        CROSS JOIN definer_role
      UNION ALL
      SELECT current_database_row.oid,
             'pg_catalog.pg_namespace'::pg_catalog.regclass,
             audit_schema.oid,
             0::pg_catalog.int4,
             'pg_catalog.pg_authid'::pg_catalog.regclass,
             definer_role.oid,
             'o'::"char"
        FROM current_database_row
        CROSS JOIN audit_schema
        CROSS JOIN definer_role
    ), observed_audit_namespace_dependencies AS (
      SELECT dependency.classid,
             dependency.objid,
             dependency.objsubid,
             dependency.refclassid,
             dependency.refobjid,
             dependency.refobjsubid,
             dependency.deptype
        FROM pg_catalog.pg_depend AS dependency
        CROSS JOIN audit_schema
       WHERE dependency.refclassid =
               'pg_catalog.pg_namespace'::pg_catalog.regclass
         AND dependency.refobjid = audit_schema.oid
    ), expected_audit_namespace_dependencies AS (
      SELECT 'pg_catalog.pg_proc'::pg_catalog.regclass AS classid,
             target.oid AS objid,
             0::pg_catalog.int4 AS objsubid,
             'pg_catalog.pg_namespace'::pg_catalog.regclass AS refclassid,
             audit_schema.oid AS refobjid,
             0::pg_catalog.int4 AS refobjsubid,
             'n'::"char" AS deptype
        FROM target
        CROSS JOIN audit_schema
    ), observed_function_acl AS (
      SELECT access.grantor,
             access.grantee,
             access.privilege_type,
             access.is_grantable
        FROM target
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            target.proacl,
            pg_catalog.acldefault('f', target.proowner)
          )
        ) AS access
    ), expected_function_acl AS (
      SELECT target.proowner AS grantor,
             role.oid AS grantee,
             'EXECUTE'::text AS privilege_type,
             false AS is_grantable
        FROM target
        JOIN pg_catalog.pg_roles AS role
          ON role.rolname IN (
            '${RESTORE_LEDGER_DEFINER_ROLE}',
            'learncoding_ops'
          )
    ), observed_audit_schema_acl AS (
      SELECT access.grantor,
             access.grantee,
             access.privilege_type,
             access.is_grantable
        FROM audit_schema
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            audit_schema.nspacl,
            pg_catalog.acldefault('n', audit_schema.nspowner)
          )
        ) AS access
    ), expected_audit_schema_acl AS (
      SELECT audit_schema.nspowner AS grantor,
             audit_schema.nspowner AS grantee,
             privilege.privilege_type,
             false AS is_grantable
        FROM audit_schema
        CROSS JOIN (
          VALUES ('CREATE'::text), ('USAGE'::text)
        ) AS privilege(privilege_type)
      UNION ALL
      SELECT audit_schema.nspowner,
             ops.oid,
             'USAGE'::text,
             false
        FROM audit_schema
        JOIN pg_catalog.pg_roles AS ops
          ON ops.rolname = 'learncoding_ops'
    ), observed_drizzle_schema_acl AS (
      SELECT access.grantor,
             access.grantee,
             access.privilege_type,
             access.is_grantable
        FROM drizzle_schema
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            drizzle_schema.nspacl,
            pg_catalog.acldefault('n', drizzle_schema.nspowner)
          )
        ) AS access
    ), expected_drizzle_schema_acl AS (
      SELECT access.grantor,
             access.grantee,
             access.privilege_type,
             access.is_grantable
        FROM drizzle_schema
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          pg_catalog.acldefault('n', drizzle_schema.nspowner)
        ) AS access
      UNION ALL
      SELECT drizzle_schema.nspowner,
             definer_role.oid,
             'USAGE'::text,
             false
        FROM drizzle_schema
        CROSS JOIN definer_role
    ), observed_ledger_acl AS (
      SELECT access.grantor,
             access.grantee,
             access.privilege_type,
             access.is_grantable
        FROM ledger
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            ledger.relacl,
            pg_catalog.acldefault('r', ledger.relowner)
          )
        ) AS access
    ), expected_ledger_acl AS (
      SELECT access.grantor,
             access.grantee,
             access.privilege_type,
             access.is_grantable
        FROM ledger
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          pg_catalog.acldefault('r', ledger.relowner)
        ) AS access
      UNION ALL
      SELECT ledger.relowner,
             definer_role.oid,
             'SELECT'::text,
             false
        FROM ledger
        CROSS JOIN definer_role
    )
    SELECT target.owner_name,
           NOT definer_role.rolcanlogin
             AND NOT definer_role.rolsuper
             AND NOT definer_role.rolinherit
             AND NOT definer_role.rolcreaterole
             AND NOT definer_role.rolcreatedb
             AND NOT definer_role.rolreplication
             AND NOT definer_role.rolbypassrls
             AND definer_role.rolconnlimit = -1
             AND definer_role.rolvaliduntil IS NULL
             AND definer_role.rolconfig IS NULL
             AS definer_role_exact,
           NOT EXISTS (
             SELECT 1
               FROM pg_catalog.pg_auth_members AS membership
              WHERE membership.roleid = definer_role.oid
                 OR membership.member = definer_role.oid
           ) AS definer_membership_exact,
           NOT EXISTS (
             SELECT 1
               FROM pg_catalog.pg_db_role_setting AS setting
              WHERE setting.setrole = definer_role.oid
           ) AS definer_role_setting_exact,
           NOT EXISTS (
             SELECT 1
               FROM pg_catalog.pg_default_acl AS defaults
              WHERE defaults.defaclrole = definer_role.oid
                 OR EXISTS (
                   SELECT 1
                     FROM pg_catalog.aclexplode(defaults.defaclacl) AS access
                    WHERE access.grantee = definer_role.oid
                 )
           ) AS definer_default_acl_exact,
           NOT EXISTS (
             (
               SELECT * FROM observed_definer_dependencies
               EXCEPT ALL
               SELECT * FROM expected_definer_dependencies
             )
             UNION ALL
             (
               SELECT * FROM expected_definer_dependencies
               EXCEPT ALL
               SELECT * FROM observed_definer_dependencies
             )
           ) AS definer_dependency_set_exact,
           NOT pg_catalog.has_database_privilege(
             definer_role.oid,
             pg_catalog.current_database(),
             'CONNECT,CREATE,TEMP'
           )
             AND NOT pg_catalog.has_schema_privilege(
             definer_role.oid,
             'public',
             'USAGE,CREATE'
           )
             AND pg_catalog.has_schema_privilege(
               definer_role.oid,
               drizzle_schema.oid,
               'USAGE'
             )
             AND NOT pg_catalog.has_schema_privilege(
               definer_role.oid,
               drizzle_schema.oid,
               'CREATE'
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_class AS relation
                 JOIN pg_catalog.pg_namespace AS namespace
                   ON namespace.oid = relation.relnamespace
                WHERE namespace.nspname IN ('public', 'drizzle')
                  AND relation.oid <> ledger.oid
                  AND (
                    (
                      relation.relkind IN ('r', 'p', 'v', 'm', 'f')
                      AND (
                        pg_catalog.has_table_privilege(
                          definer_role.oid,
                          relation.oid,
                          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
                        )
                        OR pg_catalog.has_any_column_privilege(
                          definer_role.oid,
                          relation.oid,
                          'SELECT,INSERT,UPDATE,REFERENCES'
                        )
                      )
                    )
                    OR (
                      relation.relkind = 'S'
                      AND pg_catalog.has_sequence_privilege(
                        definer_role.oid,
                        relation.oid,
                        'USAGE,SELECT,UPDATE'
                      )
                    )
                  )
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_proc AS routine
                 JOIN pg_catalog.pg_namespace AS namespace
                   ON namespace.oid = routine.pronamespace
                WHERE namespace.nspname IN ('public', 'drizzle')
                  AND pg_catalog.has_function_privilege(
                    definer_role.oid,
                    routine.oid,
                    'EXECUTE'
                  )
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_type AS type_object
                 JOIN pg_catalog.pg_namespace AS namespace
                   ON namespace.oid = type_object.typnamespace
                WHERE namespace.nspname IN ('public', 'drizzle')
                  AND type_object.typtype IN ('b', 'c', 'd', 'e', 'r', 'm')
                  AND NOT EXISTS (
                    SELECT 1
                      FROM pg_catalog.pg_type AS element_type
                     WHERE element_type.typarray = type_object.oid
                  )
                  AND pg_catalog.has_type_privilege(
                    definer_role.oid,
                    type_object.oid,
                    'USAGE'
                  )
             )
             AS definer_application_privileges_exact,
           pg_catalog.has_schema_privilege(
             definer_role.oid,
             drizzle_schema.oid,
             'USAGE'
           )
             AND NOT pg_catalog.has_schema_privilege(
               definer_role.oid,
               drizzle_schema.oid,
               'CREATE'
             )
             AND pg_catalog.has_table_privilege(
               definer_role.oid,
               ledger.oid,
               'SELECT'
             )
             AND NOT pg_catalog.has_table_privilege(
               definer_role.oid,
               ledger.oid,
               'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
             )
             AND NOT pg_catalog.has_any_column_privilege(
               definer_role.oid,
               ledger.oid,
               'INSERT,UPDATE,REFERENCES'
             )
             AND NOT EXISTS (
               (
                 SELECT * FROM observed_drizzle_schema_acl
                 EXCEPT ALL
                 SELECT * FROM expected_drizzle_schema_acl
               )
               UNION ALL
               (
                 SELECT * FROM expected_drizzle_schema_acl
                 EXCEPT ALL
                 SELECT * FROM observed_drizzle_schema_acl
               )
             )
             AND NOT EXISTS (
               (
                 SELECT * FROM observed_ledger_acl
                 EXCEPT ALL
                 SELECT * FROM expected_ledger_acl
               )
               UNION ALL
               (
                 SELECT * FROM expected_ledger_acl
                 EXCEPT ALL
                 SELECT * FROM observed_ledger_acl
               )
             )
             AS definer_drizzle_acl_exact,
           ledger.relkind = 'r'
             AND NOT ledger.relispartition
             AND NOT ledger.relhassubclass
             AND ledger.relpersistence = 'p'
             AND NOT ledger.relrowsecurity
             AND NOT ledger.relforcerowsecurity
             AND pg_catalog.pg_get_userbyid(ledger.relowner) =
               'learncoding_owner'
             AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_inherits AS inheritance
                WHERE inheritance.inhrelid = ledger.oid
                   OR inheritance.inhparent = ledger.oid
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_policy AS policy
                WHERE policy.polrelid = ledger.oid
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_rewrite AS rewrite
                WHERE rewrite.ev_class = ledger.oid
             )
             AS ledger_relation_exact,
           (
             SELECT pg_catalog.count(*) = 3
                    AND pg_catalog.bool_and(attribute.attacl IS NULL)
                    AND pg_catalog.count(*) FILTER (
                      WHERE attribute.attname = 'id'
                        AND attribute.atttypid = 'pg_catalog.int4'::pg_catalog.regtype
                        AND attribute.attnotnull
                        AND attribute.attgenerated = ''
                        AND attribute.attidentity = ''
                        AND pg_catalog.pg_get_expr(
                              default_value.adbin,
                              default_value.adrelid
                            ) =
                            'nextval(''drizzle.__drizzle_migrations_id_seq''::regclass)'
                    ) = 1
                    AND pg_catalog.count(*) FILTER (
                      WHERE attribute.attname = 'hash'
                        AND attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
                        AND attribute.attnotnull
                        AND attribute.attgenerated = ''
                        AND attribute.attidentity = ''
                        AND default_value.oid IS NULL
                    ) = 1
                    AND pg_catalog.count(*) FILTER (
                      WHERE attribute.attname = 'created_at'
                        AND attribute.atttypid = 'pg_catalog.int8'::pg_catalog.regtype
                        AND NOT attribute.attnotnull
                        AND attribute.attgenerated = ''
                        AND attribute.attidentity = ''
                        AND default_value.oid IS NULL
                    ) = 1
                    AND (
                      SELECT pg_catalog.count(*) = 1
                             AND pg_catalog.bool_and(
                               index.indisprimary
                               AND index.indisunique
                               AND index.indisvalid
                               AND index.indisready
                               AND index.indimmediate
                               AND index.indnatts = 1
                               AND index.indnkeyatts = 1
                               AND ARRAY(
                                 SELECT key_attribute.attnum
                                   FROM pg_catalog.unnest(
                                          index.indkey::pg_catalog.int2[]
                                        ) WITH ORDINALITY
                                        AS key_attribute(attnum, position)
                                  ORDER BY key_attribute.position
                               ) = ARRAY[attribute_id.attnum]::pg_catalog.int2[]
                             )
                        FROM pg_catalog.pg_index AS index
                        JOIN pg_catalog.pg_attribute AS attribute_id
                          ON attribute_id.attrelid = ledger.oid
                         AND attribute_id.attname = 'id'
                       WHERE index.indrelid = ledger.oid
                         AND index.indisprimary
                    )
               FROM pg_catalog.pg_attribute AS attribute
               LEFT JOIN pg_catalog.pg_attrdef AS default_value
                 ON default_value.adrelid = attribute.attrelid
                AND default_value.adnum = attribute.attnum
              WHERE attribute.attrelid = ledger.oid
                AND attribute.attnum > 0
                AND NOT attribute.attisdropped
           ) AS ledger_columns_exact,
           audit_schema.nspowner = definer_role.oid
             AS audit_schema_exact,
           NOT EXISTS (
             (
               SELECT * FROM observed_audit_schema_acl
               EXCEPT ALL
               SELECT * FROM expected_audit_schema_acl
             )
             UNION ALL
             (
               SELECT * FROM expected_audit_schema_acl
               EXCEPT ALL
               SELECT * FROM observed_audit_schema_acl
             )
           ) AS audit_schema_acl_exact,
           (
             SELECT pg_catalog.count(*) = 1
               FROM pg_catalog.pg_proc AS routine
              WHERE routine.pronamespace = audit_schema.oid
           )
             AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_class AS relation
                WHERE relation.relnamespace = audit_schema.oid
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_type AS type_object
                WHERE type_object.typnamespace = audit_schema.oid
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_operator AS operator_object
                WHERE operator_object.oprnamespace = audit_schema.oid
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_opclass AS operator_class
                WHERE operator_class.opcnamespace = audit_schema.oid
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_opfamily AS operator_family
                WHERE operator_family.opfnamespace = audit_schema.oid
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_collation AS collation_object
                WHERE collation_object.collnamespace = audit_schema.oid
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_conversion AS conversion_object
                WHERE conversion_object.connamespace = audit_schema.oid
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_ts_config AS configuration_object
                WHERE configuration_object.cfgnamespace = audit_schema.oid
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_ts_dict AS dictionary_object
                WHERE dictionary_object.dictnamespace = audit_schema.oid
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_ts_parser AS parser_object
                WHERE parser_object.prsnamespace = audit_schema.oid
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_ts_template AS template_object
                WHERE template_object.tmplnamespace = audit_schema.oid
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_statistic_ext AS statistic_object
                WHERE statistic_object.stxnamespace = audit_schema.oid
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_extension AS extension_object
                WHERE extension_object.extnamespace = audit_schema.oid
             )
             AS audit_object_set_exact,
           NOT EXISTS (
             (
               SELECT * FROM observed_audit_namespace_dependencies
               EXCEPT ALL
               SELECT * FROM expected_audit_namespace_dependencies
             )
             UNION ALL
             (
               SELECT * FROM expected_audit_namespace_dependencies
               EXCEPT ALL
               SELECT * FROM observed_audit_namespace_dependencies
             )
           ) AS audit_namespace_dependency_set_exact,
           NOT EXISTS (
             SELECT 1
               FROM pg_catalog.pg_extension AS extension_object
              WHERE extension_object.extnamespace IN (
                audit_schema.oid,
                drizzle_schema.oid
              )
           )
             AND NOT EXISTS (
             SELECT 1
               FROM pg_catalog.pg_depend AS dependency
              WHERE dependency.refclassid =
                      'pg_catalog.pg_extension'::pg_catalog.regclass
                AND dependency.deptype IN ('e', 'x')
                AND (
                  (
                    dependency.classid =
                      'pg_catalog.pg_proc'::pg_catalog.regclass
                    AND dependency.objid = target.oid
                  )
                  OR (
                    dependency.classid =
                      'pg_catalog.pg_namespace'::pg_catalog.regclass
                    AND dependency.objid IN (
                      audit_schema.oid,
                      drizzle_schema.oid
                    )
                  )
                  OR (
                    dependency.classid =
                      'pg_catalog.pg_class'::pg_catalog.regclass
                    AND dependency.objid = ledger.oid
                  )
                )
           ) AS authority_extension_dependency_exact,
           (
             SELECT pg_catalog.count(*) = 1
               FROM pg_catalog.pg_proc AS candidate
              WHERE candidate.pronamespace = audit_schema.oid
                AND candidate.proname = 'reviewed_migration_ledger'
           ) AS overload_set_exact,
           target.prosecdef AS security_definer,
           target.provolatile = 's' AS stable,
           target.proparallel = 'u' AS parallel_unsafe,
           target.proleakproof AS leakproof,
           target.proisstrict AS strict,
           target.language_name,
           target.prosupport = 0::pg_catalog.oid AS support_exact,
           target.probin IS NULL AS binary_exact,
           target.procost = 100 AS cost_exact,
           target.prorows = 1000 AS rows_exact,
           target.proconfig IS NOT DISTINCT FROM
             ARRAY[
               'search_path=pg_catalog, pg_temp',
               'row_security=off'
             ]::text[]
             AS search_path_exact,
           target.prokind = 'f'
             AND target.proretset
             AND target.pronargs = 0
             AND pg_catalog.pg_get_function_result(target.oid) =
               'TABLE(id text, hash text, created_at text)'
             AS signature_exact,
           pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(target.prosrc, 'UTF8')
             ),
             'hex'
           ) = '${RESTORE_LEDGER_AUTHORITY_BODY_SHA256}'
             AS body_exact,
           NOT EXISTS (
             (
               SELECT * FROM observed_function_acl
               EXCEPT ALL
               SELECT * FROM expected_function_acl
             )
             UNION ALL
             (
               SELECT * FROM expected_function_acl
               EXCEPT ALL
               SELECT * FROM observed_function_acl
             )
           ) AS acl_exact
      FROM target
      CROSS JOIN definer_role
      CROSS JOIN audit_schema
      CROSS JOIN drizzle_schema
      CROSS JOIN ledger
     /* restore_ledger_authority_catalog */
  `;
}

function authorityCatalogIsExact(row: Record<string, unknown> | undefined) {
  return exactObject(row, [
    "owner_name",
    "definer_role_exact",
    "definer_membership_exact",
    "definer_role_setting_exact",
    "definer_default_acl_exact",
    "definer_dependency_set_exact",
    "definer_application_privileges_exact",
    "definer_drizzle_acl_exact",
    "ledger_relation_exact",
    "ledger_columns_exact",
    "audit_schema_exact",
    "audit_schema_acl_exact",
    "audit_object_set_exact",
    "audit_namespace_dependency_set_exact",
    "authority_extension_dependency_exact",
    "overload_set_exact",
    "security_definer",
    "stable",
    "parallel_unsafe",
    "leakproof",
    "strict",
    "language_name",
    "support_exact",
    "binary_exact",
    "cost_exact",
    "rows_exact",
    "search_path_exact",
    "signature_exact",
    "body_exact",
    "acl_exact",
  ])
    && row?.owner_name === RESTORE_LEDGER_DEFINER_ROLE
    && row.definer_role_exact === true
    && row.definer_membership_exact === true
    && row.definer_role_setting_exact === true
    && row.definer_default_acl_exact === true
    && row.definer_dependency_set_exact === true
    && row.definer_application_privileges_exact === true
    && row.definer_drizzle_acl_exact === true
    && row.ledger_relation_exact === true
    && row.ledger_columns_exact === true
    && row.audit_schema_exact === true
    && row.audit_schema_acl_exact === true
    && row.audit_object_set_exact === true
    && row.audit_namespace_dependency_set_exact === true
    && row.authority_extension_dependency_exact === true
    && row.overload_set_exact === true
    && row.security_definer === true
    && row.stable === true
    && row.parallel_unsafe === true
    && row.leakproof === false
    && row.strict === false
    && row.language_name === "plpgsql"
    && row.support_exact === true
    && row.binary_exact === true
    && row.cost_exact === true
    && row.rows_exact === true
    && row.search_path_exact === true
    && row.signature_exact === true
    && row.body_exact === true
    && row.acl_exact === true;
}
async function verifyRestoreLedgerAuthorityCatalog(client: QueryClientLike) {
  const result = await client.query(restoreLedgerAuthorityCatalogQuery());
  if (
    result.rows.length !== 1
    || !authorityCatalogIsExact(result.rows[0])
  ) {
    throw new Error("restore migration ledger authority catalog is unsafe");
  }
}

async function verifyRestoreLedgerAuthorityInstallerSecret(
  client: QueryClientLike,
) {
  const result = await client.query(`
    SELECT pg_catalog.count(*) = 1 AS role_present,
           pg_catalog.bool_and(role.rolpassword IS NULL) AS password_absent
      FROM pg_catalog.pg_authid AS role
     WHERE role.rolname = '${RESTORE_LEDGER_DEFINER_ROLE}'
     /* restore_ledger_installer_secret */
  `);
  const row = result.rows[0];
  if (
    result.rows.length !== 1
    || !exactObject(row, ["role_present", "password_absent"])
    || row?.role_present !== true
    || row.password_absent !== true
  ) {
    throw new Error("restore migration ledger authority secret is unsafe");
  }
}

export async function verifyRestoreLedgerRuntimeAuthority(
  client: QueryClientLike,
) {
  const reviewed = await loadReviewedMigrationLedger();
  const identityResult = await client.query(`
    WITH ledger AS (
      SELECT relation.oid
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'drizzle'
         AND relation.relname = '__drizzle_migrations'
         AND relation.relkind IN ('r', 'p')
    )
    SELECT current_user::text AS current_user,
           session_user::text AS session_user,
           role.rolsuper AS superuser,
           pg_catalog.pg_has_role(
             current_user,
             'learncoding_owner',
             'MEMBER'
           ) AS owner_membership,
           pg_catalog.has_schema_privilege(
             current_user,
             'drizzle',
             'USAGE'
           ) AS drizzle_schema_usage,
           COALESCE(
             pg_catalog.has_table_privilege(
               current_user,
               ledger.oid,
               'SELECT'
             ),
             false
           ) AS ledger_select,
           COALESCE(
             pg_catalog.has_any_column_privilege(
               current_user,
               ledger.oid,
               'SELECT,INSERT,UPDATE,REFERENCES'
             ),
             false
           ) AS ledger_column_privilege
      FROM pg_catalog.pg_roles AS role
      LEFT JOIN ledger ON true
     WHERE role.rolname = current_user
     /* restore_ledger_runtime_identity */
  `);
  const identity = identityResult.rows[0];
  if (
    identityResult.rows.length !== 1
    || !exactObject(identity, [
      "current_user",
      "session_user",
      "superuser",
      "owner_membership",
      "drizzle_schema_usage",
      "ledger_select",
      "ledger_column_privilege",
    ])
    || identity?.current_user !== "learncoding_ops"
    || identity.session_user !== "learncoding_ops"
    || identity.superuser !== false
    || identity.owner_membership !== false
  ) {
    throw new Error("restore ledger runtime identity is unsafe");
  }
  if (
    identity.drizzle_schema_usage !== false
    || identity.ledger_select !== false
    || identity.ledger_column_privilege !== false
  ) {
    throw new Error("restore ops runtime has direct ledger access");
  }

  let directLedgerSelectDenied = false;
  try {
    await client.query(`
      SELECT journal.id
        FROM drizzle.__drizzle_migrations AS journal
       LIMIT 0
       /* restore_ledger_direct_select_denied */
    `);
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "42501"
    ) {
      directLedgerSelectDenied = true;
    } else {
      throw new Error("restore ops direct ledger SELECT failed unexpectedly");
    }
  }
  if (!directLedgerSelectDenied) {
    throw new Error("restore ops direct ledger SELECT was not denied");
  }

  await verifyRestoreLedgerAuthorityCatalog(client);
  const authorityRows = await client.query(`
    SELECT authority.id,
           authority.hash,
           authority.created_at
      FROM codestead_restore_audit.reviewed_migration_ledger() AS authority
     ORDER BY authority.id::pg_catalog.int8
     /* restore_reviewed_ledger_authority_rows */
  `);
  let verification: Awaited<ReturnType<
    ReviewedMigrationLedgerModule["verifyAppliedMigrationLedger"]
  >>;
  try {
    verification = await reviewed.verifyAppliedMigrationLedger({
      async query(sql: string) {
        if (sql.includes("reviewed_migration_journal_present")) {
          return {
            rows: [{ reviewed_migration_journal_present: true }],
          };
        }
        if (sql.includes("reviewed_full_migration_journal_rows")) {
          return authorityRows;
        }
        throw new Error("restore ledger verifier issued an unexpected query");
      },
    }, { requireComplete: true });
  } catch {
    throw new Error("restored database migration ledger is not the exact reviewed 0069 ledger");
  }
  if (
    verification.appliedCount !== reviewed.REVIEWED_MIGRATION_LEDGER.length
    || verification.complete !== true
    || verification.ledgerSha256 !== reviewed.REVIEWED_MIGRATION_LEDGER_SHA256
  ) {
    throw new Error("restored database migration ledger is not the exact reviewed 0069 ledger");
  }
  return verification;
}

type RestoreLedgerAuthorityIdentityOptions = Readonly<{
  expectedBootstrapUser: string;
  expectedDatabase: string;
}>;

function normalizeRestoreLedgerAuthorityIdentityOptions(
  options: Readonly<{
    expectedBootstrapUser?: string;
    expectedDatabase?: string;
  }>,
): RestoreLedgerAuthorityIdentityOptions {
  const expectedBootstrapUser =
    options.expectedBootstrapUser ?? "learncoding_restore";
  const expectedDatabase = options.expectedDatabase ?? "learncoding_restore";
  if (
    !/^[a-z_][a-z0-9_]{0,62}$/u.test(expectedBootstrapUser)
    || expectedBootstrapUser === "learncoding_owner"
    || expectedBootstrapUser === RESTORE_LEDGER_DEFINER_ROLE
    || !/^learncoding_restore(?:_[a-z0-9_]{1,40})?$/u.test(expectedDatabase)
  ) {
    throw new Error("restore ledger authority identity options are unsafe");
  }
  return { expectedBootstrapUser, expectedDatabase };
}

async function verifyRestoreLedgerInstallerIdentity(
  client: QueryClientLike,
  options: RestoreLedgerAuthorityIdentityOptions,
) {
  const identityResult = await client.query(`
    SELECT current_user::text AS current_user,
           session_user::text AS session_user,
           current_database()::text AS database_name,
           role.rolsuper AS superuser
      FROM pg_catalog.pg_roles AS role
     WHERE role.rolname = current_user
     /* restore_ledger_installer_identity */
  `);
  const identity = identityResult.rows[0];
  if (
    identityResult.rows.length !== 1
    || !exactObject(identity, [
      "current_user",
      "session_user",
      "database_name",
      "superuser",
    ])
    || identity?.current_user !== options.expectedBootstrapUser
    || identity.session_user !== options.expectedBootstrapUser
    || identity.database_name !== options.expectedDatabase
    || identity.superuser !== true
  ) {
    throw new Error("restore ledger installer identity is unsafe");
  }
}

async function loadRestoreLedgerAuthorityKinds(client: QueryClientLike) {
  const existing = await client.query(`
    SELECT 'role'::text AS object_kind
      FROM pg_catalog.pg_roles
     WHERE rolname = '${RESTORE_LEDGER_DEFINER_ROLE}'
    UNION ALL
    SELECT 'schema'::text
      FROM pg_catalog.pg_namespace
     WHERE nspname = '${RESTORE_LEDGER_AUDIT_SCHEMA}'
    UNION ALL
    SELECT 'routine'::text
      FROM pg_catalog.pg_proc AS routine
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = routine.pronamespace
     WHERE namespace.nspname = '${RESTORE_LEDGER_AUDIT_SCHEMA}'
        OR routine.proname = 'reviewed_migration_ledger'
     /* restore_ledger_existing_authority */
  `);
  const kinds = existing.rows.map((row) => row.object_kind).sort();
  if (
    kinds.some((kind) => typeof kind !== "string")
    || (
      kinds.length !== 0
      && (
        kinds.length !== 3
        || kinds[0] !== "role"
        || kinds[1] !== "routine"
        || kinds[2] !== "schema"
      )
    )
  ) {
    throw new Error("restore migration ledger authority already exists unsafely");
  }
  return kinds;
}

async function rollbackRestoreLedgerTransaction(
  client: QueryClientLike,
  primaryFailure: unknown,
): Promise<never> {
  try {
    await client.query("ROLLBACK");
  } catch (rollbackFailure) {
    throw preserveRestoreFailureWithCleanupCause(
      primaryFailure,
      [rollbackFailure],
    );
  }
  throw primaryFailure;
}

export async function installRestoreLedgerAuthority(
  client: QueryClientLike,
  options: Readonly<{
    requireLedger: boolean;
    expectedBootstrapUser?: string;
    expectedDatabase?: string;
  }>,
) {
  if (typeof options.requireLedger !== "boolean") {
    throw new Error("restore ledger installer options are invalid");
  }
  const identityOptions =
    normalizeRestoreLedgerAuthorityIdentityOptions(options);
  await verifyRestoreLedgerInstallerIdentity(client, identityOptions);

  const prerequisiteResult = await client.query(`
    SELECT EXISTS (
             SELECT 1
               FROM pg_catalog.pg_class AS relation
               JOIN pg_catalog.pg_namespace AS namespace
                 ON namespace.oid = relation.relnamespace
              WHERE namespace.nspname = 'drizzle'
                AND relation.relname = '__drizzle_migrations'
                AND relation.relkind IN ('r', 'p')
           ) AS ledger_present,
           EXISTS (
             SELECT 1 FROM pg_catalog.pg_roles
              WHERE rolname = 'learncoding_owner'
           ) AS owner_present,
           EXISTS (
             SELECT 1 FROM pg_catalog.pg_roles
              WHERE rolname = 'learncoding_ops'
           ) AS ops_present
     /* restore_ledger_install_prerequisites */
  `);
  const prerequisites = prerequisiteResult.rows[0];
  if (
    prerequisiteResult.rows.length !== 1
    || !exactObject(prerequisites, [
      "ledger_present",
      "owner_present",
      "ops_present",
    ])
    || prerequisites?.owner_present !== true
    || prerequisites.ops_present !== true
    || typeof prerequisites.ledger_present !== "boolean"
  ) {
    throw new Error("restore ledger installer prerequisites are unsafe");
  }
  if (!prerequisites.ledger_present) {
    if (options.requireLedger) {
      throw new Error("restore migration ledger is required before authority installation");
    }
    return { installed: false } as const;
  }

  try {
    await client.query("BEGIN");
    const existingKinds = await loadRestoreLedgerAuthorityKinds(client);
    if (existingKinds.length === 3) {
      await verifyRestoreLedgerAuthorityInstallerSecret(client);
      await verifyRestoreLedgerAuthorityCatalog(client);
      await client.query("COMMIT");
      return {
        installed: false,
        converged: true,
      } as const;
    }

    await client.query(`
      CREATE ROLE learncoding_restore_ledger_reader
      NOLOGIN
      NOSUPERUSER
      NOCREATEDB
      NOCREATEROLE
      NOINHERIT
      NOREPLICATION
      NOBYPASSRLS
      CONNECTION LIMIT -1
    `);
    await client.query("SET LOCAL ROLE learncoding_owner");
    await client.query(`
      GRANT USAGE ON SCHEMA drizzle
      TO learncoding_restore_ledger_reader
    `);
    await client.query(`
      GRANT SELECT ON TABLE drizzle.__drizzle_migrations
      TO learncoding_restore_ledger_reader
    `);
    await client.query("RESET ROLE");
    await client.query(`
      CREATE SCHEMA codestead_restore_audit
      AUTHORIZATION learncoding_restore_ledger_reader
    `);
    await client.query("SET LOCAL ROLE learncoding_restore_ledger_reader");
    await client.query(`
      REVOKE ALL ON SCHEMA codestead_restore_audit
      FROM PUBLIC
      CASCADE
    `);
    await client.query(`
      GRANT USAGE ON SCHEMA codestead_restore_audit
      TO learncoding_ops
    `);
    await client.query(`
      CREATE FUNCTION codestead_restore_audit.reviewed_migration_ledger()
      RETURNS TABLE(id text, hash text, created_at text)
      LANGUAGE plpgsql
      STABLE
      PARALLEL UNSAFE
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      SET row_security = off
      AS $restore_ledger_authority$${RESTORE_LEDGER_AUTHORITY_BODY}$restore_ledger_authority$
    `);
    await client.query(`
      REVOKE ALL ON FUNCTION
        codestead_restore_audit.reviewed_migration_ledger()
      FROM PUBLIC
      CASCADE
    `);
    await client.query(`
      GRANT EXECUTE ON FUNCTION
        codestead_restore_audit.reviewed_migration_ledger()
      TO learncoding_ops
    `);
    await client.query("RESET ROLE");
    await verifyRestoreLedgerAuthorityInstallerSecret(client);
    await verifyRestoreLedgerAuthorityCatalog(client);
    await client.query("COMMIT");
    return { installed: true } as const;
  } catch (error) {
    return rollbackRestoreLedgerTransaction(client, error);
  }
}

export async function removeRestoreLedgerAuthorityBeforeBootstrap(
  client: QueryClientLike,
  options: RestoreLedgerAuthorityIdentityOptions,
) {
  const identityOptions =
    normalizeRestoreLedgerAuthorityIdentityOptions(options);
  await verifyRestoreLedgerInstallerIdentity(client, identityOptions);
  try {
    await client.query("BEGIN");
    const existingKinds = await loadRestoreLedgerAuthorityKinds(client);
    if (existingKinds.length === 0) {
      await client.query("COMMIT");
      return { removed: false } as const;
    }

    await verifyRestoreLedgerAuthorityInstallerSecret(client);
    await verifyRestoreLedgerAuthorityCatalog(client);
    await client.query(`
      REVOKE EXECUTE ON FUNCTION
        codestead_restore_audit.reviewed_migration_ledger()
      FROM learncoding_ops
    `);
    await client.query(`
      DROP FUNCTION codestead_restore_audit.reviewed_migration_ledger()
      RESTRICT
    `);
    await client.query(`
      DROP SCHEMA codestead_restore_audit RESTRICT
    `);
    await client.query("SET LOCAL ROLE learncoding_owner");
    await client.query(`
      REVOKE SELECT ON TABLE drizzle.__drizzle_migrations
      FROM learncoding_restore_ledger_reader
    `);
    await client.query(`
      REVOKE USAGE ON SCHEMA drizzle
      FROM learncoding_restore_ledger_reader
    `);
    await client.query("RESET ROLE");
    await client.query(`
      DROP ROLE learncoding_restore_ledger_reader
    `);

    const afterRemoval = await loadRestoreLedgerAuthorityKinds(client);
    if (afterRemoval.length !== 0) {
      throw new Error(
        "restore migration ledger authority removal did not reach exact absence",
      );
    }
    await client.query("COMMIT");
    return { removed: true } as const;
  } catch (error) {
    return rollbackRestoreLedgerTransaction(client, error);
  }
}

async function verifyRestoredMigrationLedger(client: QueryClientLike) {
  return verifyRestoreLedgerRuntimeAuthority(client);
}

function restoredRelationAvailable(
  row: Record<string, unknown> | undefined,
  expectedName: string,
) {
  return row?.name === expectedName
    && typeof row.relation === "string"
    && row.relation.length > 0
    && (row.relkind === "r" || row.relkind === "p");
}

export async function verifyDatabaseSchema(client: QueryClientLike) {
  const countResult = await client.query(
    "SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = 'public'",
  );
  const countValue = countResult.rows[0]?.count;
  if (typeof countValue !== "string" || !/^[0-9]+$/.test(countValue)) {
    throw new Error("restored table count is invalid");
  }
  const publicTableCount = Number(countValue);
  if (!Number.isSafeInteger(publicTableCount) || publicTableCount < requiredPublicTableCount) {
    throw new Error("restored database contains too few public tables");
  }

  const requiredResult = await client.query(`
    WITH required_restore_relations(name, schema_name, relation_name) AS (
      VALUES
        ('drizzle.__drizzle_migrations'::text, 'drizzle'::text, '__drizzle_migrations'::text),
        ('public."user"'::text, 'public'::text, 'user'::text),
        ('public.course'::text, 'public'::text, 'course'::text),
        ('public.lesson'::text, 'public'::text, 'lesson'::text),
        ('public.enrollment'::text, 'public'::text, 'enrollment'::text),
        ('public.email_outbox'::text, 'public'::text, 'email_outbox'::text),
        ('public.email_outbox_idempotency_authority'::text, 'public'::text, 'email_outbox_idempotency_authority'::text),
        ('public.backup_status_mail_authority'::text, 'public'::text, 'backup_status_mail_authority'::text),
        ('public.mail_delivery_release_receipt'::text, 'public'::text, 'mail_delivery_release_receipt'::text)
    )
    SELECT required.name,
           CASE WHEN catalog.oid IS NULL THEN NULL
                ELSE required.name END AS relation,
           catalog.relkind::text AS relkind
      FROM required_restore_relations AS required
      LEFT JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.nspname = required.schema_name
      LEFT JOIN pg_catalog.pg_class AS catalog
        ON catalog.relnamespace = namespace.oid
       AND catalog.relname = required.relation_name
     ORDER BY required.name
  `);
  const byName = new Map<string, Record<string, unknown>>();
  let relationInventoryValid = requiredResult.rows.length === requiredRestoreRelations.length;
  for (const row of requiredResult.rows) {
    if (
      !exactObject(row, ["name", "relation", "relkind"])
      || typeof row.name !== "string"
      || !requiredRestoreRelations.includes(row.name as typeof requiredRestoreRelations[number])
      || byName.has(row.name)
    ) {
      relationInventoryValid = false;
      continue;
    }
    byName.set(row.name, row);
  }
  if (requiredApplicationRelations.some((name) =>
    !restoredRelationAvailable(byName.get(name), name))) {
    throw new Error("restored database is missing a required application table");
  }
  if (requiredMailAuthorityRelations.some((name) =>
    !restoredRelationAvailable(byName.get(name), name))) {
    throw new Error("restored database is missing a required mail authority relation");
  }
  if (!relationInventoryValid) {
    throw new Error("restored database relation inventory is invalid");
  }

  const ledger = await verifyRestoredMigrationLedger(client);
  return {
    appliedMigrationCount: ledger.appliedCount,
    migrationLedgerSha256: ledger.ledgerSha256,
    publicTableCount,
  };
}

export async function verifyCredentialProbe(probePath: string, masterKeyPath: string) {
  const probeBytes = await readSecureRegularFile(probePath);
  const keyBytes = await readSecureRegularFile(masterKeyPath);
  let masterKey: Buffer | undefined;
  try {
    const probe = JSON.parse(probeBytes.toString("utf8")) as unknown;
    if (!exactObject(probe, ["version", "context", "sealed", "plaintextSha256"])) {
      throw new Error("credential probe inventory is invalid");
    }
    const record = probe as Record<string, unknown>;
    if (record.version !== 1 || typeof record.plaintextSha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(record.plaintextSha256)) {
      throw new Error("credential probe metadata is invalid");
    }
    if (!exactObject(record.context, ["credentialId", "userId", "provider", "keyVersion"])) {
      throw new Error("credential probe context is invalid");
    }
    const contextRecord = record.context as Record<string, unknown>;
    if (
      typeof contextRecord.credentialId !== "string" ||
      typeof contextRecord.userId !== "string" ||
      typeof contextRecord.provider !== "string" ||
      contextRecord.keyVersion !== 1
    ) {
      throw new Error("credential probe context is invalid");
    }
    if (!exactObject(record.sealed, [
      "ciphertext", "wrappedDataKey", "wrapIv", "dataIv", "authTag", "keyVersion", "lastFour",
    ])) {
      throw new Error("sealed credential inventory is invalid");
    }
    const sealedRecord = record.sealed as Record<string, unknown>;
    for (const key of ["ciphertext", "wrappedDataKey", "wrapIv", "dataIv", "authTag", "lastFour"] as const) {
      if (typeof sealedRecord[key] !== "string") throw new Error("sealed credential metadata is invalid");
    }
    if (sealedRecord.keyVersion !== 1) throw new Error("sealed credential key version is invalid");

    masterKey = parseMasterKey(keyBytes.toString("utf8").trim());
    const plaintext = openCredential(
      record.sealed as unknown as SealedCredential,
      record.context as CredentialContext,
      masterKey,
    );
    const actual = createHash("sha256").update(plaintext, "utf8").digest();
    const expected = Buffer.from(record.plaintextSha256, "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error("credential probe plaintext hash differs");
    }
    return true;
  } finally {
    probeBytes.fill(0);
    keyBytes.fill(0);
    masterKey?.fill(0);
  }
}

async function collectRegularFiles(root: string, relative = ""): Promise<string[]> {
  const directory = relative ? path.join(root, relative) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  const output: string[] = [];
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (!/^[A-Za-z0-9._/-]+$/.test(child) || child.includes("..") || child.startsWith("/")) {
      throw new Error("restored application data contains an unsafe path");
    }
    if (entry.isSymbolicLink()) throw new Error("restored application data contains a symlink");
    if (entry.isDirectory()) output.push(...await collectRegularFiles(root, child));
    else if (entry.isFile()) output.push(child);
    else throw new Error("restored application data contains a special file");
    if (output.length > 100_000) throw new Error("restored application data exceeds the object bound");
  }
  return output;
}

export async function verifyAppData(appDataRoot: string, manifestPath: string) {
  requireAbsolute(appDataRoot, "restored app-data root");
  const metadata = await lstat(appDataRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (await realpath(appDataRoot)) !== appDataRoot) {
    throw new Error("restored app-data root is unsafe");
  }
  const manifestBytes = await readSecureRegularFile(manifestPath);
  try {
    const expected = new Map<string, Buffer>();
    const text = manifestBytes.toString("utf8");
    if (text && !text.endsWith("\n")) throw new Error("app-data manifest is not newline terminated");
    for (const line of text.split("\n").filter(Boolean)) {
      const match = /^([0-9a-f]{64})  ([A-Za-z0-9._/-]+)$/.exec(line);
      if (!match || match[2].includes("..") || match[2].startsWith("/") || expected.has(match[2])) {
        throw new Error("app-data manifest is invalid");
      }
      expected.set(match[2], Buffer.from(match[1], "hex"));
    }
    const actualFiles = (await collectRegularFiles(appDataRoot)).sort();
    if (actualFiles.length !== expected.size) throw new Error("app-data object inventory differs");
    for (const relative of actualFiles) {
      const expectedHash = expected.get(relative);
      if (!expectedHash) throw new Error("restored object is absent from the manifest");
      const bytes = await readSecureRegularFile(path.join(appDataRoot, ...relative.split("/")));
      try {
        const actualHash = createHash("sha256").update(bytes).digest();
        if (!timingSafeEqual(actualHash, expectedHash)) throw new Error("restored object hash differs");
      } finally {
        bytes.fill(0);
      }
    }
    return { objectCount: actualFiles.length };
  } finally {
    manifestBytes.fill(0);
  }
}

type RestoreSmokeEnvironment = Readonly<{
  DATABASE_URL: string;
  RESTORE_APP_DATA_ROOT: string;
  RESTORE_APP_DATA_MANIFEST: string;
  RESTORE_CREDENTIAL_PROBE: string;
  RESTORE_CREDENTIAL_MASTER_KEY_PATH: string;
}>;

export function resolveRestoreSmokeEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): RestoreSmokeEnvironment {
  if (
    environment.CREDENTIAL_MASTER_KEY !== undefined
    || environment.CREDENTIAL_MASTER_KEY_FILE !== undefined
  ) {
    throw new Error("restore smoke must not consume a generic credential key");
  }
  const databaseUrl = environment.DATABASE_URL ?? environment.RESTORE_DATABASE_URL;
  const appDataRoot = environment.RESTORE_APP_DATA_ROOT;
  const appDataManifest = environment.RESTORE_APP_DATA_MANIFEST;
  const credentialProbe = environment.RESTORE_CREDENTIAL_PROBE;
  const masterKeyFile = environment.RESTORE_CREDENTIAL_MASTER_KEY_PATH;
  if (!databaseUrl || !appDataRoot || !appDataManifest || !credentialProbe || !masterKeyFile) {
    throw new Error("restore smoke environment is incomplete");
  }
  if (masterKeyFile !== "/run/secrets/credential_master_key") {
    throw new Error("restore credential key path is not the reviewed container path");
  }
  return {
    DATABASE_URL: databaseUrl,
    RESTORE_APP_DATA_ROOT: appDataRoot,
    RESTORE_APP_DATA_MANIFEST: appDataManifest,
    RESTORE_CREDENTIAL_PROBE: credentialProbe,
    RESTORE_CREDENTIAL_MASTER_KEY_PATH: masterKeyFile,
  };
}

export async function main() {
  const environment = resolveRestoreSmokeEnvironment(process.env);
  await runWithRestoreDatabaseClient(
    environment.DATABASE_URL,
    async (client) => verifyDatabaseSchema(client),
  );
  await verifyAppData(
    environment.RESTORE_APP_DATA_ROOT,
    environment.RESTORE_APP_DATA_MANIFEST,
  );
  await verifyCredentialProbe(
    environment.RESTORE_CREDENTIAL_PROBE,
    environment.RESTORE_CREDENTIAL_MASTER_KEY_PATH,
  );
  process.stdout.write(
    "database_schema_valid=true\napp_data_valid=true\ncredential_recovery=true\n",
  );
}

function resolveRestoreLedgerAuthorityEnvironment() {
  const databaseUrl = process.env.DATABASE_BOOTSTRAP_URL;
  const expectedBootstrapUser = process.env.POSTGRES_USER;
  const expectedDatabase = process.env.POSTGRES_DB;
  if (!databaseUrl || !expectedBootstrapUser || !expectedDatabase) {
    throw new Error("restore ledger authority environment is incomplete");
  }
  return {
    databaseUrl,
    identity: normalizeRestoreLedgerAuthorityIdentityOptions({
      expectedBootstrapUser,
      expectedDatabase,
    }),
  };
}

export async function installLedgerAuthorityMain() {
  const environment = resolveRestoreLedgerAuthorityEnvironment();
  await runWithRestoreDatabaseClient(
    environment.databaseUrl,
    (client) => installRestoreLedgerAuthority(client, {
      requireLedger: process.env.REQUIRE_COMPLETE_MIGRATION_LEDGER === "true",
      ...environment.identity,
    }),
  );
}

export async function removeLedgerAuthorityBeforeBootstrapMain() {
  const environment = resolveRestoreLedgerAuthorityEnvironment();
  await runWithRestoreDatabaseClient(
    environment.databaseUrl,
    (client) => removeRestoreLedgerAuthorityBeforeBootstrap(
      client,
      environment.identity,
    ),
  );
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entry) {
  const operation = process.argv.slice(2);
  const installing = operation.length === 1
    && operation[0] === "--install-ledger-authority";
  const removingBeforeBootstrap = operation.length === 1
    && operation[0] === "--remove-ledger-authority-before-bootstrap";
  const runningSmoke = operation.length === 0;
  const execution = installing
    ? installLedgerAuthorityMain()
    : removingBeforeBootstrap
      ? removeLedgerAuthorityBeforeBootstrapMain()
      : runningSmoke
        ? main()
        : Promise.reject(new Error("restore verifier operation is invalid"));
  execution.catch(() => {
    process.stderr.write(
      installing
        ? "restore_ledger_authority_install_failed\n"
        : removingBeforeBootstrap
          ? "restore_ledger_authority_convergence_failed\n"
          : "restore_smoke_failed\n",
    );
    process.exitCode = 1;
  });
}
