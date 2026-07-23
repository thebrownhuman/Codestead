import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function deliveryScopeMigration() {
  const directory = resolve(process.cwd(), "drizzle");
  const matches = readdirSync(directory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .map((name) => ({ name, source: readFileSync(resolve(directory, name), "utf8") }))
    .filter(({ source }) => source.includes("delivery_scope_key"));
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

describe("email outbox delivery-scope migration", () => {
  it("backfills account, registered system, and unresolved scopes without guessing", () => {
    const { source } = deliveryScopeMigration();
    const normalized = source.toLowerCase();

    expect(normalized).toContain("add column \"delivery_scope_key\"");
    expect(normalized).toMatch(/'a:'\s*\|\|\s*"?user_id"?/u);
    expect(normalized).toMatch(/'s:'\s*\|\|\s*"?operation_id"?::text/u);
    expect(normalized).toMatch(/'o:'\s*\|\|\s*"?operation_id"?::text/u);
    expect(normalized).toContain("access-rejected");
    expect(normalized).toContain("invitation");
    const systemBackfill = normalized
      .split("--> statement-breakpoint")
      .find((statement) => statement.includes("'s:' || \"operation_id\"::text"));
    expect(systemBackfill).toContain('"user_id" is null');
    expect(systemBackfill).toContain('"template_version" = \'1\'');
    expect(systemBackfill).toContain('"template" in (\'invitation\', \'access-rejected\')');
    expect(systemBackfill).not.toContain('"to_email"');
    expect(systemBackfill).not.toContain('"variables"');
    expect(normalized).toContain("unresolved-recipient@invalid.local");
    expect(normalized).toContain('"variables" = \'{}\'::jsonb');
    expect(normalized).toMatch(/not\s*\([\s\S]*status"?\s*=\s*'sending'[\s\S]*lease_expires_at[\s\S]*>\s*now\(\)\s*\)/u);
  });

  it("quarantines unresolved claimable history and excludes it from scoped delivery", () => {
    const { source } = deliveryScopeMigration();
    const normalized = source.toLowerCase();

    expect(normalized).toContain("unresolved_delivery_scope");
    expect(normalized).toContain("quarantined_at");
    expect(normalized).toMatch(/status[\s\S]+in\s*\(\s*'pending'\s*,\s*'sending'\s*\)/u);
    expect(normalized).toContain("email_outbox_delivery_scope_idx");
    expect(normalized).toContain('"claim_token" = null');
    expect(normalized).toContain('"claim_owner" = null');
    expect(normalized).toContain('"lease_expires_at" = null');
    expect(normalized).toContain("unresolved_delivery_scope_provider_unknown");
    expect(normalized).toContain('"provider_call_started" is not null');
    expect(normalized).toContain('"provider_call_started" is null');
    expect(normalized).toContain('"claim_version" = "claim_version" + 1');
  });

  it("keeps orphan scopes terminal and makes assigned authority immutable", () => {
    const { source } = deliveryScopeMigration();
    const normalized = source.toLowerCase();

    expect(normalized).not.toContain('"template" = \'account-deleted\'');
    expect(normalized).toContain('"status" in (\'sent\', \'failed\', \'suppressed\', \'quarantined\')');
    expect(normalized).toContain("enforce_email_outbox_delivery_scope_immutable");
    expect(normalized).toContain("create trigger \"email_outbox_delivery_scope_immutable\"");
    expect(normalized).toContain('before update of "operation_id", "delivery_scope_key"');
  });

  it("preserves 0057 lineage in migration metadata", () => {
    const directory = resolve(process.cwd(), "drizzle", "meta");
    const journal = JSON.parse(readFileSync(resolve(directory, "_journal.json"), "utf8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const current = JSON.parse(readFileSync(resolve(directory, "0058_snapshot.json"), "utf8")) as {
      id: string;
      prevId: string;
    };
    const previous = JSON.parse(readFileSync(resolve(directory, "0057_snapshot.json"), "utf8")) as {
      id: string;
    };

    expect(journal.entries.find(({ tag }) => tag === "0058_mail_delivery_scope"))
      .toMatchObject({ idx: 58, tag: "0058_mail_delivery_scope" });
    expect(current.prevId).toBe(previous.id);
    expect(current.id).not.toBe(previous.id);
  });
});
