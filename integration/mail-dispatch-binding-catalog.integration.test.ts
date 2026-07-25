import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

const { Pool } = pg;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

describe("temporary pinned-PG17 0064 catalog probe", () => {
  const owner = new Pool({
    application_name: "codestead_pg17_0064_catalog_probe",
    connectionString: requiredEnvironment("DATABASE_URL"),
    max: 1,
  });

  afterAll(async () => {
    await owner.end();
  });

  it("prints the canonical constraint and routine definitions", async () => {
    const constraint = await owner.query<{
      expression: string;
      normalized_expression: string;
      definition: string;
      version: string;
    }>(`
      SELECT pg_catalog.current_setting('server_version_num') version,
             pg_catalog.pg_get_expr(
               constraint_row.conbin,
               constraint_row.conrelid,
               true
             ) expression,
             pg_catalog.regexp_replace(
               pg_catalog.regexp_replace(
                 pg_catalog.pg_get_expr(
                   constraint_row.conbin,
                   constraint_row.conrelid,
                   true
                 ),
                 '"?email_outbox"?[.]', '', 'g'
               ),
               '[[:space:]"]', '', 'g'
             ) normalized_expression,
             pg_catalog.pg_get_constraintdef(
               constraint_row.oid,
               true
             ) definition
        FROM pg_catalog.pg_constraint constraint_row
       WHERE constraint_row.conrelid =
               'public.email_outbox'::pg_catalog.regclass
         AND constraint_row.conname =
               'email_outbox_dispatch_binding_valid'
    `);
    expect(constraint.rows).toHaveLength(1);

    const routines = await owner.query<{
      signature: string;
      definition: string;
      body: string;
      procost: number;
      prorows: number;
      prosupport: string;
      protrftypes: string[] | null;
      probin: string | null;
      prosqlbody: string | null;
    }>(`
      SELECT p.oid::pg_catalog.regprocedure::text signature,
             pg_catalog.pg_get_functiondef(p.oid) definition,
             p.prosrc body,
             p.procost,
             p.prorows,
             p.prosupport::pg_catalog.regproc::text prosupport,
             p.protrftypes::text[] protrftypes,
             p.probin,
             p.prosqlbody::text
        FROM pg_catalog.pg_proc p
       WHERE p.oid = ANY(
         ARRAY[
           'public.redact_unresolved_email_outbox_authority(timestamp with time zone,integer)'::pg_catalog.regprocedure,
           'public.classify_email_outbox_retention_redaction(public.email_outbox,timestamp with time zone)'::pg_catalog.regprocedure,
           'public.enforce_email_outbox_payload_immutable()'::pg_catalog.regprocedure,
           'public.enforce_email_outbox_dispatch_binding()'::pg_catalog.regprocedure
         ]::oid[]
       )
       ORDER BY signature
    `);
    expect(routines.rows).toHaveLength(4);

    const evidence = {
      event: "pg17_0064_catalog_probe",
      constraint: constraint.rows[0],
      routines: routines.rows.map(({ definition, body, ...routine }) => ({
        ...routine,
        definitionSha256:
          createHash("sha256").update(definition).digest("hex"),
        bodySha256: createHash("sha256").update(body).digest("hex"),
      })),
    };
    writeFileSync(
      "C:/tmp/pg17-0064-catalog.json",
      `${JSON.stringify(evidence)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  });
});
