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
    expect(source).toContain("function accountMailAuthorityPredicate");
    expect(source).toContain("function deletionNoticeCapabilityPredicate");
    expect(source).toContain("DECISION_DELETION_CAPABILITY_SQL");
    expect(source).toContain("SUPPRESSION_DELETION_CAPABILITY_SQL");
    expect(source).toContain("BOUNDARY_DELETION_CAPABILITY_SQL");
    expect(normalized).toContain("account_deletion_tombstone");
    expect(normalized).toContain("data_lifecycle_run");
    expect(normalized).toContain("{deletionnotice,recipienthmacsha256}");
    expect(normalized).toContain("{deletionnotice,payloadsha256}");
    expect(normalized).toContain("deletion_notice_capability_invalid");
    expect(normalized).toContain("account_not_active_at_provider_boundary");
    expect(normalized).toContain("account_user.email");
    expect(normalized).toContain("account_user.status = 'pending'");
    expect(normalized).toContain("${outbox}.template = 'verify-email'");
    expect(normalized).toContain("${outbox}.template = 'reset-password'");
    expect(normalized).toContain("account_user.status in ('pending', 'active')");
    expect(normalized).toContain("'invitation', 'access-rejected', 'account-deleted'");
  });

  it("binds the provider permit to the exact claimed payload", () => {
    expect(normalized).toContain("outbox.to_email = lower(btrim($8::text))");
    expect(normalized).toContain("outbox.template = $9::text");
    expect(normalized).toContain("outbox.template_version = $10::text");
    expect(normalized).toContain("outbox.variables = $11::jsonb");
  });
});
