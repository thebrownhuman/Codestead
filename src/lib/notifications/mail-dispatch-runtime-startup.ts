const MINIMUM_MAIL_DISPATCH_POSTGRES_MAJOR = 17;
const FAILURE_MESSAGE = "Mail dispatch requires PostgreSQL 17 or newer.";

type RuntimeVersionRow = {
  readonly server_version_num: unknown;
};

export type PostgresRuntimeQueryable = {
  query(
    queryText: string,
  ): Promise<{ readonly rows: readonly RuntimeVersionRow[] }>;
};

export class MailDispatchPostgresRuntimeError extends Error {
  constructor() {
    super(FAILURE_MESSAGE);
    this.name = "POSTGRES_RUNTIME_UNSUPPORTED";
  }
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
    return parsePostgresServerVersionNum(result.rows[0]?.server_version_num);
  } catch {
    throw new MailDispatchPostgresRuntimeError();
  }
}
