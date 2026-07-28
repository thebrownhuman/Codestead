type DisposableIntegrationResetResult = Readonly<{
  rowCount: number | null;
  rows: readonly Record<string, unknown>[];
}>;

export type DisposableIntegrationResetClient = Readonly<{
  query: (
    statement: string,
  ) => PromiseLike<DisposableIntegrationResetResult>;
  release: (destroy?: boolean) => void;
}>;

export type DisposableIntegrationResetPool = Readonly<{
  connect: () => PromiseLike<DisposableIntegrationResetClient>;
}>;

const CALLER_TIMEOUT_SQL = `SET LOCAL lock_timeout = '5000ms';
SET LOCAL statement_timeout = '30000ms';
SET LOCAL idle_in_transaction_session_timeout = '30000ms'`;

const CALLER_IDENTITY_SQL = `
SELECT current_database()::text AS current_database,
       session_user::text AS session_user,
       current_user::text AS current_user
`;

function resetEnvironmentIsDisposable(): boolean {
  let databaseUrl: URL;
  try {
    databaseUrl = new URL(process.env.DATABASE_URL ?? "");
  } catch {
    return false;
  }
  const port = Number(databaseUrl.port);
  return process.env.INTEGRATION_TEST === "1"
    && databaseUrl.protocol === "postgresql:"
    && databaseUrl.username === "learncoding_app"
    && databaseUrl.password.length > 0
    && databaseUrl.hostname === "127.0.0.1"
    && databaseUrl.pathname === "/learncoding_integration"
    && Number.isSafeInteger(port)
    && port >= 1
    && port <= 65_535
    && port !== 5_432
    && databaseUrl.search === ""
    && databaseUrl.hash === "";
}

function throwPreservingResetFailures(
  primaryFailure: { error: unknown } | undefined,
  cleanupFailures: readonly unknown[],
): void {
  if (primaryFailure && cleanupFailures.length > 0) {
    throw new AggregateError(
      [primaryFailure.error, ...cleanupFailures],
      "disposable integration reset failed and cleanup also failed",
      { cause: primaryFailure.error },
    );
  }
  if (primaryFailure) throw primaryFailure.error;
  if (cleanupFailures.length === 1) throw cleanupFailures[0];
  if (cleanupFailures.length > 1) {
    throw new AggregateError(
      cleanupFailures,
      "disposable integration reset cleanup failed",
    );
  }
}

export async function resetDisposableIntegrationDatabase(
  database: DisposableIntegrationResetPool,
): Promise<void> {
  if (!resetEnvironmentIsDisposable()) {
    throw new Error("disposable integration reset is unavailable");
  }

  let client: DisposableIntegrationResetClient | undefined;
  let transactionAttempted = false;
  let transactionFinished = false;
  let destroyClient = false;
  let primaryFailure: { error: unknown } | undefined;
  const cleanupFailures: unknown[] = [];

  try {
    client = await database.connect();
    transactionAttempted = true;
    await client.query("BEGIN");
    await client.query(CALLER_TIMEOUT_SQL);

    const identity = await client.query(CALLER_IDENTITY_SQL);
    const identityRow = identity.rows[0];
    if (
      identity.rows.length !== 1
      || identityRow?.current_database !== "learncoding_integration"
      || identityRow.session_user !== "learncoding_app"
      || identityRow.current_user !== "learncoding_app"
    ) {
      throw new Error("disposable integration reset caller identity mismatch");
    }

    const result = await client.query(
      "select codestead_disposable_test.reset_database()",
    );
    if (result.rowCount !== 1 || result.rows.length !== 1) {
      throw new Error("disposable integration reset did not complete");
    }

    await client.query("COMMIT");
    transactionFinished = true;
  } catch (error) {
    primaryFailure = { error };
    if (client && transactionAttempted && !transactionFinished) {
      try {
        await client.query("ROLLBACK");
        transactionFinished = true;
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
        destroyClient = true;
      }
    }
  } finally {
    if (client) {
      try {
        if (destroyClient) client.release(true);
        else client.release();
      } catch (cleanupError) {
        cleanupFailures.push(cleanupError);
      }
    }
  }

  throwPreservingResetFailures(primaryFailure, cleanupFailures);
}