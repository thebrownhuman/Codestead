import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "drizzle",
  "0060_mail_outbox_payload_immutability.sql",
);
const migration = existsSync(migrationPath)
  ? readFileSync(migrationPath, "utf8").toLowerCase()
  : "";

const immutableColumns = [
  "user_id",
  "to_email",
  "template",
  "template_version",
  "variables",
  "idempotency_key",
  "operation_id",
  "delivery_scope_key",
] as const;

const mutableDeliveryColumns = [
  "status",
  "attempt_count",
  "claim_token",
  "claim_owner",
  "claim_version",
  "lease_expires_at",
  "provider_call_started",
  "adapter",
  "provider_message_id",
  "next_attempt_at",
  "sent_at",
  "quarantined_at",
  "last_error_code",
  "updated_at",
] as const;

describe("0060 email outbox payload immutability", () => {
  it("registers the migration and snapshot after 0059", () => {
    const metaDirectory = resolve(process.cwd(), "drizzle", "meta");
    const journal = JSON.parse(
      readFileSync(resolve(metaDirectory, "_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    const snapshotPath = resolve(metaDirectory, "0060_snapshot.json");

    expect(existsSync(migrationPath)).toBe(true);
    expect(
      journal.entries.find((entry) => entry.tag === "0060_mail_outbox_payload_immutability"),
    ).toMatchObject({
      idx: 60,
      tag: "0060_mail_outbox_payload_immutability",
    });
    expect(existsSync(snapshotPath)).toBe(true);

    const current = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
      id: string;
      prevId: string;
    };
    const previous = JSON.parse(
      readFileSync(resolve(metaDirectory, "0059_snapshot.json"), "utf8"),
    ) as { id: string };

    expect(current.prevId).toBe(previous.id);
    expect(current.id).not.toBe(previous.id);
  });

  it("rejects every authority-bearing payload mutation with a constraint error", () => {
    expect(migration).toContain(
      'create function "public"."enforce_email_outbox_payload_immutable"()',
    );
    expect(migration).toContain("errcode = '23514'");

    for (const column of immutableColumns) {
      expect(migration).toContain(
        `old.${column} is distinct from new.${column}`,
      );
    }
  });

  it("fires only for payload columns and preserves delivery-state updates", () => {
    const trigger = migration
      .split("--> statement-breakpoint")
      .find((statement) =>
        statement.includes('create trigger "email_outbox_payload_immutable"'),
      ) ?? "";

    expect(trigger).toContain("before update of");
    for (const column of immutableColumns) {
      expect(trigger).toContain(`"${column}"`);
    }
    for (const column of mutableDeliveryColumns) {
      expect(trigger).not.toContain(`"${column}"`);
    }
  });

  it("retires the narrower predecessor trigger and function", () => {
    expect(migration).toContain(
      'drop trigger "email_outbox_delivery_scope_immutable" on "email_outbox"',
    );
    expect(migration).toContain(
      'drop function "public"."enforce_email_outbox_delivery_scope_immutable"()',
    );
  });
});
