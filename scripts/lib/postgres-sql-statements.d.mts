export type PostgresStatement = Readonly<{
  start: number;
  end: number;
  sql: string;
}>;

export function splitPostgresStatements(
  source: string,
): readonly PostgresStatement[];

export function canonicalizePostgresStatement(statement: string): string;
