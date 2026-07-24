import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const read = (relativePath: string) =>
  readFileSync(resolve(process.cwd(), relativePath), "utf8");

const migration = read("drizzle/0059_mail_delivery_scope_contract.sql");
const migrationStatements = migration.split("--> statement-breakpoint");
const normalizedStatements = migrationStatements.map((statement) =>
  statement.toLowerCase(),
);

const envelopeFragments = [
  "_mailOperationId",
  "_mailRecipient",
  "_mailProducer",
  "_mailSourceId",
] as const;

function statementContaining(...fragments: string[]) {
  const index = normalizedStatements.findIndex((statement) =>
    fragments.every((fragment) => statement.includes(fragment)),
  );
  return {
    exact: migrationStatements[index] ?? "",
    index,
    normalized: normalizedStatements[index] ?? "",
  };
}

describe("0059 system-mail authority envelope", () => {
  it("classifies a legacy admin envelope before retagging it for strict validation", () => {
    const adminTemplateRetag = statementContaining(
      `set "template" = 'access-request-admin'`,
    );
    const systemBackfill = statementContaining(
      `set "delivery_scope_key" = 's:' || "operation_id"::text`,
    );
    const predecessorConstraintDrop = statementContaining(
      'drop constraint "email_outbox_delivery_scope_valid"',
    );

    expect(adminTemplateRetag.normalized).toContain('"template" = \'invitation\'');
    expect(predecessorConstraintDrop.index).toBeGreaterThanOrEqual(0);
    expect(systemBackfill.index).toBeGreaterThan(predecessorConstraintDrop.index);
    expect(systemBackfill.exact).toContain(
      `"variables" ->> '_mailOperationId' = "operation_id"::text`,
    );
    expect(systemBackfill.exact).toContain(
      `"variables" ->> '_mailRecipient' = "to_email"`,
    );
    expect(systemBackfill.exact).toContain(`"variables" ->> '_mailSourceId'`);
    expect(systemBackfill.exact).toContain(`"variables" ->> '_mailProducer'`);
    expect(systemBackfill.normalized).toContain(`"template" = 'invitation'`);
    expect(systemBackfill.normalized).toContain(
      `"template" = 'access-request-admin'`,
    );
    expect(systemBackfill.normalized).toContain(`"template" = 'access-rejected'`);
    expect(systemBackfill.normalized).not.toContain(
      `"template" in ('invitation', 'access-rejected')`,
    );
  });

  it("normalizes broad predecessor system scopes before applying the strict contract", () => {
    const disableTrigger = statementContaining(
      'disable trigger "email_outbox_delivery_scope_immutable"',
    );
    const normalizeLegacy = statementContaining(
      'set "delivery_scope_key" = null',
      `"delivery_scope_key" = 's:' || "operation_id"::text`,
    );
    const enableTrigger = statementContaining(
      'enable trigger "email_outbox_delivery_scope_immutable"',
    );
    const activeLeaseGuard = statementContaining(
      "active unresolved delivery-scope lease",
    );

    expect(disableTrigger.index).toBeGreaterThanOrEqual(0);
    expect(normalizeLegacy.index).toBeGreaterThan(disableTrigger.index);
    expect(enableTrigger.index).toBeGreaterThan(normalizeLegacy.index);
    expect(activeLeaseGuard.index).toBeGreaterThan(enableTrigger.index);
    for (const fragment of envelopeFragments) {
      expect(normalizeLegacy.exact).toContain(fragment);
    }
    expect(normalizeLegacy.normalized).toContain(
      `"template" = 'access-request-admin'`,
    );
  });

  it("requires exact system producer/template/source truth-table pairs", () => {
    const strictConstraint = statementContaining(
      "email_outbox_delivery_scope_valid",
      "add constraint",
    );

    for (const fragment of envelopeFragments) {
      expect(strictConstraint.exact).toContain(fragment);
    }
    expect(strictConstraint.exact).toContain(
      `"email_outbox"."variables" ->> '_mailSourceId'`,
    );
    expect(strictConstraint.normalized).toContain(
      `"email_outbox"."template" = 'access-request-admin'`,
    );
    expect(strictConstraint.exact).toContain(
      `"email_outbox"."variables" ->> '_mailProducer' IS NOT DISTINCT FROM 'access-request-admin'`,
    );
    expect(strictConstraint.exact).toContain(
      `"email_outbox"."variables" ->> '_mailProducer' IS NOT DISTINCT FROM 'access-request-approved'`,
    );
    expect(strictConstraint.exact).toContain(
      `"email_outbox"."variables" ->> '_mailProducer' IS NOT DISTINCT FROM 'access-request-rejected'`,
    );
    expect(strictConstraint.exact).not.toContain(
      `"email_outbox"."template" = 'invitation' AND "email_outbox"."variables" ->> '_mailProducer' IS NOT DISTINCT FROM 'access-request-admin'`,
    );
  });

  it("keeps the Drizzle schema and 0059 snapshot aligned", () => {
    const schema = read("src/lib/db/schema.ts");
    const schemaConstraint = schema.slice(
      schema.indexOf('check(\n      "email_outbox_delivery_scope_valid"'),
      schema.indexOf("  ],\n);\n\nexport const inactivityEpisode"),
    );
    const snapshot = JSON.parse(read("drizzle/meta/0059_snapshot.json")) as {
      tables: Record<string, {
        checkConstraints: Record<string, { value: string }>;
      }>;
    };
    const snapshotConstraint = snapshot.tables["public.email_outbox"]
      ?.checkConstraints.email_outbox_delivery_scope_valid?.value ?? "";

    for (const fragment of ["access-request-admin", ...envelopeFragments]) {
      expect(schemaConstraint).toContain(fragment);
      expect(snapshotConstraint).toContain(fragment);
    }
  });

  it("requires every exact-cased reserved envelope field in backfill and constraint", () => {
    const registeredBackfill = statementContaining(
      `set "delivery_scope_key" = 's:' || "operation_id"::text`,
    );
    const strictConstraint = statementContaining(
      "email_outbox_delivery_scope_valid",
      "add constraint",
    );

    for (const fragment of envelopeFragments) {
      expect(registeredBackfill.exact).toContain(fragment);
      expect(strictConstraint.exact).toContain(fragment);
    }
  });
});
