import { PgDialect } from "drizzle-orm/pg-core";

const dialect = new PgDialect();

export function capturedOutboxRow(statement: unknown) {
  const { params } = dialect.sqlToQuery(statement as never);
  const [
    operationId,
    userId,
    deliveryScopeKey,
    toEmail,
    template,
    templateVersion,
    variablesJson,
    idempotencyKey,
    idempotencyAuthorityVersion,
  ] = params;
  return {
    operationId,
    userId,
    deliveryScopeKey,
    toEmail,
    template,
    templateVersion,
    variables: JSON.parse(String(variablesJson)) as Record<string, string>,
    idempotencyKey,
    idempotencyAuthorityVersion,
  };
}
