import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "src/lib/notifications/postgres-outbox-store.ts"),
  "utf8",
);
const normalized = source.replace(/\s+/g, " ").toLowerCase();

describe("PostgresOutboxStore delivery authority", () => {
  it("shares the canonical user-authority advisory lock namespace", () => {
    expect(source).toContain('import { userAuthorityLockKey } from "@/lib/security/user-authority-lock"');
    expect(normalized).toContain("pg_advisory_xact_lock(pg_catalog.hashtext($1))");
    expect(normalized).toContain("pg_try_advisory_xact_lock(pg_catalog.hashtext($1))");
    expect(normalized).not.toContain("hashtextextended");
  });

  it("claims at most one eligible row per populated account or system scope", () => {
    expect(normalized).toContain("delivery_scope_key");
    expect(normalized).toContain("row_number() over");
    expect(normalized).toContain("partition by candidate.delivery_scope_key");
    expect(normalized).toContain("delivery_scope_key = 'a:' || user_id");
    expect(normalized).toContain("delivery_scope_key = 's:' || operation_id::text");
    expect(normalized).toContain("active.delivery_scope_key = candidate.delivery_scope_key");
    expect(normalized).toContain("active.provider_call_started is not null");
  });

  it("revalidates account authority and the exact post-deletion notice capability", () => {
    expect(normalized).toContain('from public."user"');
    expect(normalized).toContain("account_deletion_tombstone");
    expect(normalized).toContain("deletion_notice_capability_invalid");
    expect(normalized).toContain("account_not_active_at_provider_boundary");
    expect(normalized).toContain("outbox.template_version = '1'");
    expect(normalized).toContain("account_user.email");
    expect(normalized).toContain("account_user.status = 'pending'");
    expect(normalized).toContain("outbox.template = 'verify-email'");
    expect(normalized).toContain("outbox.template = 'reset-password'");
    expect(normalized).toContain("account_user.status in ('pending', 'active')");
    expect(normalized).toContain("outbox.template in ( 'lost-device-proof'");
    expect(normalized).toContain("'weekly-summary', 'backup-status'");
    expect(normalized).not.toContain("outbox.template not in");
  });

  it("fails closed for system mail unless its persisted envelope has live source authority", () => {
    expect(normalized).not.toContain("when outbox.user_id is null then 'allowed'");
    expect(normalized).toContain("system_email_authority_invalid");
    expect(normalized).toContain("outbox.variables ->> '_mailoperationid' = outbox.operation_id::text");
    expect(normalized).toContain("outbox.variables ->> '_mailrecipient' = outbox.to_email");
    expect(normalized).toContain("outbox.variables ->> '_mailproducer' = 'access-request-admin'");
    expect(normalized).toContain("outbox.template = 'access-request-admin'");
    expect(normalized).toContain("admin_recipient.status = 'active'");
    expect(normalized).toContain("admin_recipient.role = 'admin'");
    expect(normalized).toContain("source_request.status = 'pending'");

    expect(normalized).toContain("outbox.variables ->> '_mailproducer' = 'access-request-approved'");
    expect(normalized).toContain("source_invitation.access_request_id = source_request.id");
    expect(normalized).toContain("source_request.status = 'approved'");
    expect(normalized).toContain("source_invitation.token_hash = $12::text");
    expect(normalized).toContain("source_invitation.expires_at > pg_catalog.statement_timestamp()");
    expect(normalized).toContain("source_invitation.consumed_at is null");
    expect(normalized).toContain("source_request.name = outbox.variables ->> 'name'");

    expect(normalized).toContain("outbox.variables ->> '_mailproducer' = 'access-request-rejected'");
    expect(normalized).toContain("source_request.status = 'rejected'");
    expect(normalized).toContain("not (outbox.variables ? 'url')");
  });

  it("repeats an allowed authority decision under live source row locks", () => {
    expect(normalized).toContain("lockauthorityrows");
    expect(normalized).toContain("for share of account_user");
    expect(normalized).toContain("for share of source_invitation, source_request");
    expect(normalized).toContain("for share of source_request, admin_recipient");
    expect((normalized.match(/variables ->> '_mailoperationid'/g) ?? []).length)
      .toBeGreaterThanOrEqual(2);
    expect((normalized.match(/source_invitation\.expires_at > pg_catalog\.statement_timestamp\(\)/g) ?? []).length)
      .toBeGreaterThanOrEqual(2);
  });

  it("binds the provider permit to the exact claimed payload", () => {
    expect(normalized).toContain("outbox.to_email = lower($8::text)");
    expect(normalized).toContain("outbox.template = $9::text");
    expect(normalized).toContain("outbox.template_version = $10::text");
    expect(normalized).toContain("outbox.variables = $11::jsonb");
  });
});
