import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(process.cwd(), "src/lib/notifications/postgres-outbox-store.ts"),
  "utf8",
);
const compact = source.replace(/\s+/g, " ");
const normalized = compact.toLowerCase();

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

  it("fails closed for system mail unless its exact-cased envelope has live source authority", () => {
    expect(normalized).not.toContain("when outbox.user_id is null then 'allowed'");
    expect(normalized).toContain("system_email_authority_invalid");
    expect(compact).toContain("outbox.variables ->> '_mailOperationId' = outbox.operation_id::text");
    expect(compact).toContain("outbox.variables ->> '_mailRecipient' = outbox.to_email");
    expect(compact).toContain("outbox.variables ->> '_mailSourceId'");
    expect(compact).toContain("outbox.variables ->> '_mailProducer' = 'access-request-admin'");
    expect(normalized).toContain("outbox.template = 'access-request-admin'");
    expect(normalized).toContain("admin_recipient.status = 'active'");
    expect(normalized).toContain("admin_recipient.role = 'admin'");
    expect(normalized).toContain("admin_recipient.banned = false");
    expect(normalized).toContain("source_request.status = 'pending'");
    expect(normalized).toContain("source_request.adult_confirmed_at is not null");
    expect(normalized).toContain("source_request.decided_by is null");
    expect(normalized).toContain("source_request.decision_reason is null");
    expect(normalized).toContain("source_request.decided_at is null");
    expect(compact).toContain("outbox.variables ->> 'name' = 'Administrator'");
    expect(compact).toContain("outbox.variables ->> 'url' = $13::text");

    expect(compact).toContain("outbox.variables ->> '_mailProducer' = 'access-request-approved'");
    expect(normalized).toContain("source_invitation.access_request_id = source_request.id");
    expect(normalized).toContain("source_request.status = 'approved'");
    expect(normalized).toContain("source_invitation.created_by = source_request.decided_by");
    expect(normalized).toContain("source_invitation.token_hash = $12::text");
    expect(normalized).toContain("source_invitation.expires_at > pg_catalog.statement_timestamp()");
    expect(normalized).toContain("source_invitation.consumed_at is null");
    expect(normalized).toContain("source_request.name = outbox.variables ->> 'name'");

    expect(compact).toContain("outbox.variables ->> '_mailProducer' = 'access-request-rejected'");
    expect(normalized).toContain("source_request.status = 'rejected'");
    expect(normalized).toContain("source_request.decided_by is not null");
    expect(normalized).toContain("source_request.decision_reason is not null");
    expect(normalized).toContain("source_request.decided_at is not null");
    expect(normalized).toContain("not (outbox.variables ? 'url')");
  });

  it("keeps the system producer/template/source truth table fail closed", () => {
    expect(compact).not.toContain(
      "outbox.template = 'invitation' and outbox.variables ->> '_mailProducer' = 'access-request-admin'",
    );
    expect(compact).not.toContain(
      "outbox.template = 'access-request-admin' and outbox.variables ->> '_mailProducer' = 'access-request-approved'",
    );
    expect((compact.match(/variables ->> '_mailSourceId'/g) ?? []).length)
      .toBeGreaterThanOrEqual(6);
  });
  it("repeats audited live authority under source row locks and in the atomic update", () => {
    expect(normalized).toContain("lockauthorityrows");
    expect(normalized).toContain("for share of account_user");
    expect(normalized).toContain("for share of source_invitation, source_request");
    expect(normalized).toContain("for share of source_request, admin_recipient");
    expect((compact.match(/variables ->> '_mailOperationId'/g) ?? []).length)
      .toBeGreaterThanOrEqual(2);
    expect((compact.match(/variables ->> '_mailSourceId'/g) ?? []).length)
      .toBeGreaterThanOrEqual(6);
    for (const fragment of [
      "admin_recipient.banned = false",
      "source_request.adult_confirmed_at is not null",
      "source_request.decided_by is null",
      "source_request.decision_reason is null",
      "source_request.decided_at is null",
      "source_invitation.created_by = source_request.decided_by",
    ]) {
      expect(normalized.split(fragment).length - 1)
        .toBeGreaterThanOrEqual(2);
    }
    expect((normalized.match(/source_request\.decided_by is not null/g) ?? []).length)
      .toBeGreaterThanOrEqual(4);
    expect((normalized.match(/source_request\.decision_reason is not null/g) ?? []).length)
      .toBeGreaterThanOrEqual(4);
    expect((normalized.match(/source_request\.decided_at is not null/g) ?? []).length)
      .toBeGreaterThanOrEqual(4);
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
