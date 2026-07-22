import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function reliabilityMigration() {
  const directory = resolve(process.cwd(), "drizzle");
  const matches = readdirSync(directory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .map((name) => ({ name, source: readFileSync(resolve(directory, name), "utf8") }))
    .filter(({ source }) => source.includes("LEGACY_SENDING_AMBIGUOUS"));
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

describe("mail outbox reliability migration", () => {
  it("conservatively quarantines every legacy sending row", () => {
    const migration = reliabilityMigration();

    expect(migration.source).toMatch(/update\s+"email_outbox"[\s\S]+"?status"?\s*=\s*'quarantined'[\s\S]+where\s+"?status"?\s*=\s*'sending'/iu);
    expect(migration.source).toContain("LEGACY_SENDING_AMBIGUOUS");
    expect(migration.source).not.toMatch(/"?status"?\s*=\s*'pending'[\s\S]+"?status"?\s*=\s*'sending'/iu);
  });

  it("adds stable operation, fencing, provider-boundary, and settlement evidence", () => {
    const { source } = reliabilityMigration();

    for (const column of [
      "operation_id",
      "claim_token",
      "claim_owner",
      "claim_version",
      "lease_expires_at",
      "provider_call_started",
      "adapter",
      "provider_message_id",
      "quarantined_at",
    ]) expect(source).toContain(`"${column}"`);
  });
  it("uses a transaction-safe enum replacement before the quarantine backfill", () => {
    const { source } = reliabilityMigration();
    const rename = source.indexOf('RENAME TO "notification_status_old"');
    const create = source.indexOf('CREATE TYPE "public"."notification_status"');
    const cast = source.indexOf('USING "status"::text::"public"."notification_status"');
    const backfill = source.indexOf('SET "status" = \'quarantined\'');

    expect(source).not.toMatch(/ALTER TYPE[\s\S]+ADD VALUE/iu);
    expect(rename).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(rename);
    expect(cast).toBeGreaterThan(create);
    expect(backfill).toBeGreaterThan(cast);
  });

  it("enforces scoped nonblank provider evidence and unique claim fencing", () => {
    const { source } = reliabilityMigration();

    expect(source).toMatch(/CREATE UNIQUE INDEX "email_outbox_claim_token_unique"[\s\S]+WHERE (?:"email_outbox"\.)?"claim_token" IS NOT NULL/iu);
    expect(source).toMatch(/CREATE UNIQUE INDEX "email_outbox_provider_message_unique"[\s\S]+WHERE (?:"email_outbox"\.)?"provider_message_id" IS NOT NULL/iu);
    expect(source).toContain("email_outbox_provider_identity_valid");
    expect(source).toMatch(/btrim\((?:"email_outbox"\.)?"provider_message_id"\) <> ''/iu);
    expect(source).toMatch(/btrim\((?:"email_outbox"\.)?"adapter"\) <> ''/iu);
    expect(source).toMatch(/btrim\((?:"email_outbox"\.)?"last_error_code"\) <> ''/iu);
  });
  it("preserves the exact enum ACL instead of inheriting creator defaults", () => {
    const { source } = reliabilityMigration();
    const normalized = source.toLowerCase();

    expect(normalized).toContain("aclexplode");
    expect(normalized).toContain("acldefault('t'");
    expect(normalized).toContain("notification_status_old");
    expect(normalized).toContain(
      "revoke all privileges on type public.notification_status",
    );
    expect(normalized).toContain("grant usage on type public.notification_status");
    expect(normalized).toContain("enum owner does not match migration role");
    expect(normalized).toMatch(/if acl\.grantee = 0 then\s+grantee_sql := 'public'/u);
    expect(normalized).toContain("unresolved role oid");
    expect(normalized).toContain("delegated acl grantor");
  });

  it("keeps the generated journal and snapshot lineage coupled to 0057", () => {
    const directory = resolve(process.cwd(), "drizzle");
    const journal = JSON.parse(
      readFileSync(resolve(directory, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    const current = JSON.parse(
      readFileSync(resolve(directory, "meta", "0057_snapshot.json"), "utf8"),
    ) as { id: string; prevId: string };
    const previous = JSON.parse(
      readFileSync(resolve(directory, "meta", "0056_snapshot.json"), "utf8"),
    ) as { id: string };

    expect(journal.entries.at(-1)).toMatchObject({
      idx: 57,
      tag: "0057_mail_outbox_reliability",
    });
    expect(current.prevId).toBe(previous.id);
    expect(current.id).not.toBe(previous.id);
  });
});
