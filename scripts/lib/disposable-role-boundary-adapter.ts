export type DisposableRoleUrls = Readonly<{
  app: string;
  migrator: string;
  worker: string;
  ops: string;
  backupReporter: string;
}>;

type BoundaryPoolProbe = Readonly<{
  connectionString: string;
  database: string;
  role: string;
}>;

export type DisposableBoundaryPoolOptions = Readonly<{
  application_name: string;
  connectionString: string;
  connectionTimeoutMillis: number;
  idleTimeoutMillis: number;
  max: number;
  statement_timeout: number;
}>;

type RoleBoundaryVerifierOptions<Pool> = Readonly<{
  postgresDatabase: string;
  databaseAppUrl: string;
  databaseMigratorUrl: string;
  databaseWorkerUrl: string;
  databaseOpsUrl: string;
  databaseBackupReporterUrl: string;
  requireApplicationObjects: boolean;
  lockTimeoutMs: number;
  poolFactory: (input: BoundaryPoolProbe) => Pool;
}>;

const ROLE_URL_KEY_BY_DATABASE_ROLE = Object.freeze({
  learncoding_app: "app",
  learncoding_migrator: "migrator",
  learncoding_worker: "worker",
  learncoding_ops: "ops",
  learncoding_backup_reporter: "backupReporter",
} as const);

function canonicalDatabaseRoleUrl(scopedConnectionString: string) {
  const url = new URL(scopedConnectionString);
  url.hostname = "postgres";
  url.port = "5432";
  return url.href;
}

export async function verifyDisposableIntegrationRoleBoundaries<Pool>(
  input: Readonly<{
    database: string;
    roleUrls: DisposableRoleUrls;
    requireApplicationObjects: boolean;
    verifyDatabaseRoleBoundaries: (
      options: RoleBoundaryVerifierOptions<Pool>,
    ) => Promise<unknown>;
    createPool: (options: DisposableBoundaryPoolOptions) => Pool;
  }>,
): Promise<void> {
  await input.verifyDatabaseRoleBoundaries({
    postgresDatabase: input.database,
    databaseAppUrl: canonicalDatabaseRoleUrl(input.roleUrls.app),
    databaseMigratorUrl: canonicalDatabaseRoleUrl(input.roleUrls.migrator),
    databaseWorkerUrl: canonicalDatabaseRoleUrl(input.roleUrls.worker),
    databaseOpsUrl: canonicalDatabaseRoleUrl(input.roleUrls.ops),
    databaseBackupReporterUrl:
      canonicalDatabaseRoleUrl(input.roleUrls.backupReporter),
    requireApplicationObjects: input.requireApplicationObjects,
    lockTimeoutMs: 10_000,
    poolFactory: ({ connectionString, role }) => {
      const roleName = ROLE_URL_KEY_BY_DATABASE_ROLE[
        role as keyof typeof ROLE_URL_KEY_BY_DATABASE_ROLE
      ];
      if (!roleName) {
        throw new Error("disposable integration role URL mapping mismatch");
      }

      const connectionUrl = new URL(connectionString);
      const scopedUrl = new URL(input.roleUrls[roleName]);
      connectionUrl.hostname = scopedUrl.hostname;
      connectionUrl.port = scopedUrl.port;
      return input.createPool({
        application_name: `codestead_integration_boundary_${roleName}`,
        connectionString: connectionUrl.href,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 1_000,
        max: 1,
        statement_timeout: 5_000,
      });
    },
  });
}
