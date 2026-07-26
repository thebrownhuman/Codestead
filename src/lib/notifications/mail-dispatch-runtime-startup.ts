const MINIMUM_MAIL_DISPATCH_POSTGRES_MAJOR = 17;
const FAILURE_MESSAGE = "Mail dispatch requires PostgreSQL 17 or newer.";
const DELIVERY_AUTHORITY_FAILURE_MESSAGE =
  "Mail delivery authority is unavailable.";

type RuntimeVersionRow = {
  readonly server_version_num: unknown;
};

type DeliveryAuthorityRuntimeRow = {
  readonly delivery_release_capability_exact: unknown;
  readonly hold_catalog_exact: unknown;
  readonly hold_catalog_present: unknown;
};

export type PostgresRuntimeQueryable = {
  query(
    queryText: string,
  ): Promise<{
    readonly rows: readonly (
      | RuntimeVersionRow
      | DeliveryAuthorityRuntimeRow
    )[];
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
    typeof row?.hold_catalog_present !== "boolean"
    || typeof row.hold_catalog_exact !== "boolean"
    || typeof row.delivery_release_capability_exact !== "boolean"
    || row.hold_catalog_present !== row.hold_catalog_exact
    || (
      row.delivery_release_capability_exact
      && !row.hold_catalog_exact
    )
  ) {
    throw new MailDeliveryAuthorityRuntimeError();
  }

  return {
    holdCatalogExact: row.hold_catalog_exact,
    deliveryReleaseCapabilityExact:
      row.delivery_release_capability_exact,
  };
}

export function parsePostgresServerVersionNum(versionNum: unknown): {
  readonly major: number;
  readonly versionNum: number;
} {
  if (
    typeof versionNum !== "string"
    || !/^[1-9][0-9]{4,7}$/u.test(versionNum)
  ) {
    throw new MailDispatchPostgresRuntimeError();
  }

  const parsedVersionNum = Number.parseInt(versionNum, 10);
  const major = Math.floor(parsedVersionNum / 10_000);
  if (
    !Number.isSafeInteger(parsedVersionNum)
    || major < MINIMUM_MAIL_DISPATCH_POSTGRES_MAJOR
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
    return parsePostgresServerVersionNum(
      row?.server_version_num,
    );
  } catch {
    throw new MailDispatchPostgresRuntimeError();
  }
}

/**
 * Detects the Task 5 hold without depending on any Task 7 object name.
 *
 * Task 7 will replace the constant-false release proof with its exact catalog
 * verifier. Until then, a complete 0067 hold is deliberately non-runnable.
 */
export async function requireMailDeliveryAuthorityRuntime(
  database: PostgresRuntimeQueryable,
): Promise<MailDeliveryAuthorityRuntimeVerdict> {
  try {
    const result = await database.query(`
      WITH hold_column AS (
        SELECT
          pg_catalog.count(*)::pg_catalog.int4 AS footprint_count,
          pg_catalog.coalesce(
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
        SELECT
          pg_catalog.count(*) FILTER (
            WHERE migration.created_at = 1784997273087
              AND migration.hash ~ '^[0-9a-f]{64}$'
          )::pg_catalog.int4 AS phase_0066_count,
          pg_catalog.count(*) FILTER (
            WHERE migration.created_at = 1785002172253
              AND migration.hash ~ '^[0-9a-f]{64}$'
          )::pg_catalog.int4 AS phase_0067_count,
          pg_catalog.count(*) FILTER (
            WHERE migration.created_at > 1784997273087
          )::pg_catalog.int4 AS after_0066_count
        FROM drizzle.__drizzle_migrations AS migration
      )
      SELECT
        CASE
          WHEN lineage.phase_0067_count = 1
            OR lineage.after_0066_count > 0
            OR hold.footprint_count > 0
            THEN TRUE
          WHEN lineage.phase_0066_count = 1
            AND lineage.after_0066_count = 0
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
            AND lineage.after_0066_count = 0
            AND hold.footprint_count = 0
            THEN FALSE
          ELSE NULL
        END AS hold_catalog_exact,
        FALSE AS delivery_release_capability_exact
      FROM hold_column AS hold
      CROSS JOIN migration_lineage AS lineage
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
