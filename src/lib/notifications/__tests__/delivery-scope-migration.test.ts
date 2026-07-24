import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function migration(name: string) {
  return readFileSync(resolve(process.cwd(), "drizzle", name), "utf8");
}

describe("email outbox delivery-scope migration", () => {
  it("backfills account, registered system, and unresolved scopes without guessing", () => {
    const source = migration("0058_mail_delivery_scope.sql");
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
    const source = migration("0058_mail_delivery_scope.sql");
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
    const source = migration("0058_mail_delivery_scope.sql");
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

  it("catches rolling null rows under a write lock and drains only unresolved active leases", () => {
    const normalized = migration("0059_mail_delivery_scope_contract.sql").toLowerCase();
    const statements = normalized.split("--> statement-breakpoint");
    const accountBackfill = statements.findIndex((statement) =>
      statement.includes(`set "delivery_scope_key" = 'a:' || "user_id"`),
    );
    const systemBackfill = statements.findIndex((statement) =>
      statement.includes(`set "delivery_scope_key" = 's:' || "operation_id"::text`),
    );
    const activeLeaseGuard = statements.findIndex((statement) =>
      statement.includes("email_outbox has an active unresolved delivery-scope lease"),
    );
    const orphanBackfill = statements.findIndex((statement) =>
      statement.includes(`set "delivery_scope_key" = 'o:' || "operation_id"::text`),
    );

    expect(normalized).toContain('lock table "email_outbox" in share row exclusive mode');
    expect(accountBackfill).toBeGreaterThanOrEqual(0);
    expect(systemBackfill).toBeGreaterThan(accountBackfill);
    expect(activeLeaseGuard).toBeGreaterThan(systemBackfill);
    expect(orphanBackfill).toBeGreaterThan(activeLeaseGuard);
    expect(normalized).toContain("errcode = '55006'");
    expect(normalized).toContain('"delivery_scope_key" is null');
    expect(normalized).toContain('"status" = \'sending\'');
    expect(normalized).toContain('"lease_expires_at" > statement_timestamp()');
  });

  it("atomically quarantines and scrubs claimable orphan rows while preserving terminal evidence", () => {
    const normalized = migration("0059_mail_delivery_scope_contract.sql").toLowerCase();
    const statements = normalized.split("--> statement-breakpoint");
    const claimable = statements.find((statement) =>
      statement.includes("'o:' || \"operation_id\"::text")
      && statement.includes('"status" = \'quarantined\''),
    );
    const terminal = statements.find((statement) =>
      statement.includes("'o:' || \"operation_id\"::text")
      && statement.includes("'sent', 'failed', 'suppressed', 'quarantined'"),
    );

    expect(claimable).toContain('"to_email" = \'unresolved-recipient@invalid.local\'');
    expect(claimable).toContain('"variables" = \'{}\'::jsonb');
    expect(claimable).toContain("unresolved_delivery_scope_provider_unknown");
    expect(claimable).toContain("unresolved_delivery_scope");
    expect(claimable).toContain('"claim_token" = null');
    expect(claimable).toContain('"claim_owner" = null');
    expect(claimable).toContain('"lease_expires_at" = null');
    expect(claimable).toContain('"claim_version" < 2147483647');
    expect(terminal).toContain('"to_email" = \'unresolved-recipient@invalid.local\'');
    expect(terminal).toContain('"variables" = \'{}\'::jsonb');
    expect(terminal).not.toContain('"status" = \'quarantined\'');
  });

  it("closes the nullable expansion contract and preserves exact a/s/o authority", () => {
    const normalized = migration("0059_mail_delivery_scope_contract.sql").toLowerCase();
    const strictConstraint = normalized
      .split("--> statement-breakpoint")
      .find((statement) => statement.includes("email_outbox_delivery_scope_valid")
        && statement.includes("add constraint"));

    expect(strictConstraint).toContain("'a:' || \"email_outbox\".\"user_id\"");
    expect(strictConstraint).toContain("'s:' || \"email_outbox\".\"operation_id\"::text");
    expect(strictConstraint).toContain("'o:' || \"email_outbox\".\"operation_id\"::text");
    expect(strictConstraint).not.toMatch(/delivery_scope_key"\s+is\s+null\s+or/u);
    expect(normalized).toContain('alter column "delivery_scope_key" set not null');
  });

  it("journals a strict 0059 snapshot descended from 0058", () => {
    const directory = resolve(process.cwd(), "drizzle", "meta");
    const journal = JSON.parse(readFileSync(resolve(directory, "_journal.json"), "utf8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const current = JSON.parse(readFileSync(resolve(directory, "0059_snapshot.json"), "utf8")) as {
      id: string;
      prevId: string;
      tables: Record<string, {
        columns: Record<string, { notNull: boolean }>;
        checkConstraints: Record<string, { value: string }>;
      }>;
    };
    const previous = JSON.parse(readFileSync(resolve(directory, "0058_snapshot.json"), "utf8")) as {
      id: string;
    };
    const outbox = current.tables["public.email_outbox"]!;

    expect(
      journal.entries.find(
        ({ tag }) => tag === "0059_mail_delivery_scope_contract",
      ),
    ).toMatchObject({
      idx: 59,
      tag: "0059_mail_delivery_scope_contract",
    });
    expect(current.prevId).toBe(previous.id);
    expect(current.id).not.toBe(previous.id);
    expect(outbox.columns.delivery_scope_key?.notNull).toBe(true);
    expect(outbox.checkConstraints.email_outbox_delivery_scope_valid?.value)
      .not.toMatch(/delivery_scope_key"?\s+is\s+null\s+or/iu);
  });

  it("keeps every raw PostgreSQL integration fixture inside the strict scope contract", () => {
    for (const name of [
      "mentor-evidence.integration.test.ts",
      "tutor-memory.integration.test.ts",
    ]) {
      const source = readFileSync(
        resolve(process.cwd(), "integration", name),
        "utf8",
      );
      const columnLists = [...source.matchAll(
        /insert\s+into\s+email_outbox\s*\(([^)]+)\)/giu,
      )].map((match) => match[1]!.toLowerCase());

      expect(columnLists, name).not.toHaveLength(0);
      expect(columnLists.every((columns) => columns.includes("delivery_scope_key")), name)
        .toBe(true);
    }
  });
});
