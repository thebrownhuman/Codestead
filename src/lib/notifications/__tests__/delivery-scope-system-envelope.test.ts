import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const read = (relativePath: string) =>
  readFileSync(resolve(process.cwd(), relativePath), "utf8");

const migration = read("drizzle/0059_mail_delivery_scope_contract.sql");
const normalizedMigration = migration.toLowerCase();
const migrationStatements = normalizedMigration.split("--> statement-breakpoint");

const envelopeFragments = [
  "_mailoperationid",
  "_mailrecipient",
  "_mailproducer",
  "_mailsourceid",
] as const;

describe("0059 system-mail authority envelope", () => {
  it("classifies a legacy admin envelope before retagging it for strict validation", () => {
    const adminTemplateRetag = migrationStatements.find((statement) =>
      statement.includes(`set "template" = 'access-request-admin'`),
    );
    const systemBackfill = migrationStatements.find((statement) =>
      statement.includes(
        `set "delivery_scope_key" = 's:' || "operation_id"::text`,
      ),
    );
    const predecessorConstraintDropIndex = migrationStatements.findIndex(
      (statement) =>
        statement.includes(
          'drop constraint "email_outbox_delivery_scope_valid"',
        ),
    );
    const systemBackfillIndex = migrationStatements.indexOf(systemBackfill ?? "");

    expect(
      adminTemplateRetag ?? "",
      "0059 must retag legacy admin-producer invitations",
    ).toContain('"template" = \'invitation\'');
    expect(predecessorConstraintDropIndex).toBeGreaterThanOrEqual(0);
    expect(systemBackfillIndex).toBeGreaterThan(predecessorConstraintDropIndex);
    expect(systemBackfill).toContain(
      `"variables" ->> '_mailoperationid' = "operation_id"::text`,
    );
    expect(systemBackfill).toContain(
      `"variables" ->> '_mailrecipient' = "to_email"`,
    );
    expect(systemBackfill).toContain(`"variables" ->> '_mailsourceid'`);
    expect(systemBackfill).toContain(`"template" = 'invitation'`);
    expect(systemBackfill).toContain(`"template" = 'access-request-admin'`);
    expect(systemBackfill).toContain(
      `"variables" ->> '_mailproducer' = 'access-request-admin'`,
    );
    expect(systemBackfill).toContain(
      `"variables" ->> '_mailproducer' in ('access-request-admin', 'access-request-approved')`,
    );
    expect(systemBackfill).toContain(`"template" = 'access-rejected'`);
    expect(systemBackfill).toContain(
      `"variables" ->> '_mailproducer' = 'access-request-rejected'`,
    );
    expect(systemBackfill).not.toContain(
      `"template" in ('invitation', 'access-rejected')`,
    );
  });

  it("normalizes broad predecessor system scopes before applying the strict contract", () => {
    const disableTriggerIndex = migrationStatements.findIndex((statement) =>
      statement.includes(
        'disable trigger "email_outbox_delivery_scope_immutable"',
      ),
    );
    const normalizeLegacyIndex = migrationStatements.findIndex((statement) =>
      statement.includes('set "delivery_scope_key" = null')
      && statement.includes(
        `"delivery_scope_key" = 's:' || "operation_id"::text`,
      ),
    );
    const enableTriggerIndex = migrationStatements.findIndex((statement) =>
      statement.includes(
        'enable trigger "email_outbox_delivery_scope_immutable"',
      ),
    );
    const activeLeaseGuardIndex = migrationStatements.findIndex((statement) =>
      statement.includes("active unresolved delivery-scope lease"),
    );
    const normalizeLegacy = migrationStatements[normalizeLegacyIndex] ?? "";

    expect(disableTriggerIndex).toBeGreaterThanOrEqual(0);
    expect(normalizeLegacyIndex).toBeGreaterThan(disableTriggerIndex);
    expect(enableTriggerIndex).toBeGreaterThan(normalizeLegacyIndex);
    expect(activeLeaseGuardIndex).toBeGreaterThan(enableTriggerIndex);
    expect(normalizeLegacy).toContain(`"template" = 'access-request-admin'`);
    expect(normalizeLegacy).toContain(
      `"variables" ->> '_mailproducer' is not distinct from 'access-request-admin'`,
    );
    expect(normalizeLegacy).toContain(
      `"variables" ->> '_mailoperationid' is not distinct from "operation_id"::text`,
    );
    expect(normalizeLegacy).toContain(
      `coalesce("variables" ->> '_mailsourceid'`,
    );
  });

  it("requires exact system producer/template pairs", () => {
    const strictConstraint = migrationStatements.find((statement) =>
      statement.includes("email_outbox_delivery_scope_valid")
      && statement.includes("add constraint"),
    );

    expect(strictConstraint).toContain(
      `"email_outbox"."variables" ->> '_mailoperationid' is not distinct from "email_outbox"."operation_id"::text`,
    );
    expect(strictConstraint).toContain(
      `"email_outbox"."variables" ->> '_mailrecipient' is not distinct from "email_outbox"."to_email"`,
    );
    expect(strictConstraint).toContain(
      `"email_outbox"."variables" ->> '_mailsourceid'`,
    );
    expect(strictConstraint).toContain(
      `"email_outbox"."template" = 'access-request-admin'`,
    );
    expect(strictConstraint).toContain(
      `"email_outbox"."variables" ->> '_mailproducer' is not distinct from 'access-request-admin'`,
    );
    expect(strictConstraint).toContain(
      `"email_outbox"."variables" ->> '_mailproducer' is not distinct from 'access-request-approved'`,
    );
    expect(strictConstraint).toContain(
      `"email_outbox"."variables" ->> '_mailproducer' is not distinct from 'access-request-rejected'`,
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

    for (const fragment of [
      "access-request-admin",
      "_mailOperationId",
      "_mailRecipient",
      "_mailProducer",
      "_mailSourceId",
    ]) {
      expect(schemaConstraint).toContain(fragment);
      expect(snapshotConstraint).toContain(fragment);
    }
  });

  it("requires every reserved envelope field in both backfill and constraint", () => {
    const registeredBackfill = migrationStatements.find((statement) =>
      statement.includes(
        `set "delivery_scope_key" = 's:' || "operation_id"::text`,
      ),
    ) ?? "";
    const strictConstraint = migrationStatements.find((statement) =>
      statement.includes("email_outbox_delivery_scope_valid")
      && statement.includes("add constraint"),
    ) ?? "";

    for (const fragment of envelopeFragments) {
      expect(registeredBackfill).toContain(fragment);
      expect(strictConstraint).toContain(fragment);
    }
  });
});
