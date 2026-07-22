export interface DatabaseSecretValues {
  postgresUser: string;
  postgresDatabase: string;
  postgresPassword: string;
  databaseBootstrapUrl: string;
  databaseAppUrl: string;
  databaseMigratorUrl: string;
  databaseWorkerUrl: string;
  databaseOpsUrl: string;
}

export interface ValidatedDatabaseSecretValues {
  bootstrapUser: string;
  database: string;
  restrictedUsers: string[];
}

export function validateDatabaseSecretValues(
  values: DatabaseSecretValues,
): ValidatedDatabaseSecretValues;
