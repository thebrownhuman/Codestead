import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "drizzle",
  "0068_mail_outbox_quarantine_redaction_authority_v2.sql",
);
const migration = existsSync(migrationPath)
  ? readFileSync(migrationPath, "utf8").toLowerCase()
  : "";
const retention = readFileSync(
  resolve(process.cwd(), "src/lib/data-lifecycle/retention.ts"),
  "utf8",
).toLowerCase();
const liveHarness = readFileSync(
  resolve(
    process.cwd(),
    "infra/tests/mail-quarantine-redaction-0068.integration.mjs",
  ),
  "utf8",
).toLowerCase();

describe("0068 quarantined mail payload-redaction authority v2", () => {
  it("follows the durable replay authority and defines the v2 redactor", () => {
    expect(existsSync(migrationPath)).toBe(true);
    expect(migration).toMatch(
      /create or replace function\s+"public"\."classify_email_outbox_quarantine_redaction_v2"/u,
    );
    expect(migration).toMatch(
      /create or replace function\s+"public"\."redact_quarantined_email_outbox_authority_v2"/u,
    );
  });

  it("preserves immutable original-event authority instead of hashing redacted payload", () => {
    for (const authorityObject of [
      "email_outbox_idempotency_authority",
      "email_outbox_idempotency_coverage_authority",
      "idempotency_authority_version",
      "idempotency_authority_sha256",
      "idempotency_payload_sha256",
    ]) {
      expect(migration, authorityObject).toContain(authorityObject);
    }

    const updateStart = migration.indexOf("update public.email_outbox as outbox");
    const updateEnd = migration.indexOf("returning outbox.id", updateStart);
    expect(updateStart).toBeGreaterThanOrEqual(0);
    expect(updateEnd).toBeGreaterThan(updateStart);
    const redactionUpdate = migration.slice(updateStart, updateEnd);
    for (const immutableAuthorityColumn of [
      "idempotency_key",
      "idempotency_authority_version",
      "idempotency_authority_sha256",
      "idempotency_payload_sha256",
    ]) {
      expect(redactionUpdate).not.toMatch(
        new RegExp(`\\b${immutableAuthorityColumn}\\s*=`, "u"),
      );
    }
    expect(migration).not.toContain(
      "digest(redacted",
    );
  });

  it("makes every original-event authority field immutable through redaction", () => {
    const triggerStatement = migration
      .split("--> statement-breakpoint")
      .find((statement) =>
        statement.includes('create trigger "email_outbox_payload_immutable"'),
      ) ?? "";

    for (const authorityColumn of [
      "idempotency_authority_version",
      "idempotency_authority_sha256",
      "idempotency_payload_sha256",
    ]) {
      expect(migration).toMatch(
        new RegExp(
          `old\\.${authorityColumn}\\s+is not distinct from\\s+new\\.${authorityColumn}`,
          "u",
        ),
      );
      expect(migration).toMatch(
        new RegExp(
          `if old\\.${authorityColumn}\\s+is distinct from\\s+new\\.${authorityColumn} then`,
          "u",
        ),
      );
      expect(triggerStatement).toContain(`"${authorityColumn}"`);
    }
  });
  it("keeps durable authority triggers enabled while seeding damaged fixtures", () => {
    expect(liveHarness).not.toContain("disable trigger user");
    expect(liveHarness).not.toContain("enable trigger user");
    expect(liveHarness).toContain(
      "disable trigger email_outbox_provider_correlation_evidence_guard",
    );
    expect(liveHarness).toContain(
      "enable trigger email_outbox_provider_correlation_evidence_guard",
    );
  });

  it("keeps coverage proof and exact deletion in one outer retention transaction", () => {
    const coverage = retention.indexOf(
      "await runterminaldeletioncoverage(",
    );
    const deletion = retention.indexOf(
      "const deletedemail = await client.query<idrow>(",
      coverage,
    );

    expect(retention).toContain(
      "public.email_outbox_idempotency_coverage_authority(",
    );
    expect(coverage).toBeGreaterThanOrEqual(0);
    expect(deletion).toBeGreaterThan(coverage);
    expect(retention.slice(deletion)).toContain(
      "and id = any($3::uuid[])",
    );
  });
});
