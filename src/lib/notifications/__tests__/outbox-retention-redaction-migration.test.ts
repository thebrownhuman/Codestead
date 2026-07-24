import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "drizzle",
  "0062_mail_outbox_retention_redaction.sql",
);
const migration = existsSync(migrationPath)
  ? readFileSync(migrationPath, "utf8").toLowerCase()
  : "";
const retention = readFileSync(
  resolve(process.cwd(), "src/lib/data-lifecycle/retention.ts"),
  "utf8",
).toLowerCase();

describe("0062 mail outbox retention redaction", () => {
  it("registers a forward migration after 0061", () => {
    const journal = JSON.parse(
      readFileSync(resolve(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };

    expect(existsSync(migrationPath)).toBe(true);
    expect(journal.entries.at(-1)).toMatchObject({
      idx: 62,
      tag: "0062_mail_outbox_retention_redaction",
    });
  });

  it("exposes only an owner-defined, ops-only redaction capability", () => {
    expect(migration).toContain(
      'create or replace function "public"."redact_unresolved_email_outbox_authority"',
    );
    expect(migration).toContain("security definer");
    expect(migration).toContain("set search_path = pg_catalog");
    expect(migration).toContain(
      'alter function "public"."redact_unresolved_email_outbox_authority"',
    );
    expect(migration).toContain("owner to learncoding_owner");
    expect(migration).toMatch(
      /revoke all on function[\s\S]+from public,\s*learncoding_app,\s*learncoding_worker,\s*learncoding_migrator,\s*learncoding_ops/u,
    );
    expect(migration).toMatch(
      /grant execute on function[\s\S]+to learncoding_ops/u,
    );
    expect(migration).toContain("update public.email_outbox");
    expect(migration).toContain("session_user <> 'learncoding_ops'");
    expect(migration).toContain("current_user <> 'learncoding_owner'");
    expect(migration).toContain(
      "raise exception 'email outbox redaction caller is not authorized'",
    );
  });

  it("fences the trigger exception to one-way old account quarantine redaction", () => {
    expect(migration).toContain(
      'create or replace function "public"."enforce_email_outbox_payload_immutable"()',
    );
    for (const fragment of [
      "current_user = 'learncoding_owner'",
      "session_user = 'learncoding_ops'",
      "old.user_id is not null",
      "old.delivery_scope_key = 'a:' || old.user_id",
      "old.status = 'quarantined'",
      "old.provider_call_started is not null",
      "old.provider_message_id is null",
      "old.sent_at is null",
      "old.adapter = 'gmail'",
      "new.adapter = 'gmail'",
      "old.lease_expires_at is not null",
      "old.lease_expires_at <= pg_catalog.statement_timestamp()",
      "old.updated_at < pg_catalog.statement_timestamp() - interval '30 days'",
      "new.to_email = 'redacted+' || old.id::text || '@invalid.local'",
      "new.variables = '{}'::jsonb",
      "new.updated_at = pg_catalog.statement_timestamp()",
    ]) expect(migration).toContain(fragment);
  });

  it("limits both eligibility views to Gmail reconciliation authority", () => {
    expect(migration).toContain("candidate.adapter = 'gmail'");
    expect(migration).toContain("candidate.lease_expires_at is not null");
    expect(migration).toContain(
      "candidate.lease_expires_at <= pg_catalog.statement_timestamp()",
    );
    expect(retention).toContain("and adapter = 'gmail'");
    expect(retention).toContain("and lease_expires_at is not null");
    expect(retention).toContain(
      "and lease_expires_at <= statement_timestamp()",
    );
    expect(migration).not.toMatch(/lease_expires_at is null\s+or/iu);
    expect(retention).not.toMatch(/lease_expires_at is null\s+or/iu);
  });

  it("routes retention through the capability and leaves system envelopes untouched", () => {
    expect(retention).toContain(
      "from public.redact_unresolved_email_outbox_authority(",
    );
    expect(retention).not.toContain(
      "update email_outbox\n              set to_email = 'redacted+'",
    );
    expect(retention).toContain("delivery_scope_key = 'a:' || user_id");
  });
});
