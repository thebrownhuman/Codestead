import type { Pool } from "pg";

export const PROTECTED_APPLICATION_TABLES = Object.freeze([
  "backup_status_mail_authority",
  "backup_status_mail_admin_guard",
] as const);

export async function truncateMutableApplicationTables(
  pool: Pick<Pool, "query">,
) {
  const result = await pool.query<{ table_name: string }>(
    `
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_type = 'BASE TABLE'
       AND NOT (table_name = ANY($1::text[]))
  `,
    [PROTECTED_APPLICATION_TABLES],
  );
  if (result.rows.length === 0) return;

  const identifiers = result.rows
    .map(({ table_name }) => `"${table_name.replaceAll('"', '""')}"`)
    .join(", ");
  await pool.query(`TRUNCATE TABLE ${identifiers} RESTART IDENTITY CASCADE`);
}
