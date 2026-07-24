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
    expect(normalized).toContain("outbox.template_version = '1'");
    expect(normalized).toContain("account_user.email");
    expect(normalized).toContain("account_user.status = 'pending'");
    expect(normalized).toContain("${outbox}.template = 'verify-email'");
    expect(normalized).toContain("${outbox}.template = 'reset-password'");
    expect(normalized).toContain("account_user.status in ('pending', 'active')");
    expect(normalized).toContain("${outbox}.template in ( 'lost-device-proof'");
    expect(normalized).toContain("'weekly-summary', 'backup-status'");
    expect(normalized).not.toContain("outbox.template not in");
  });

  it("fails closed for exact-cased system envelopes without live source authority", () => {
    expect(normalized).not.toContain("when outbox.user_id is null then 'allowed'");
    expect(normalized).toContain("system_email_authority_invalid");
    for (const key of [
      "_mailOperationId",
      "_mailRecipient",
      "_mailProducer",
      "_mailSourceId",
    ]) {
      expect(compact).toContain(key);
    }

    expect(normalized).toContain("admin_recipient.status = 'active'");
    expect(normalized).toContain("admin_recipient.role = 'admin'");
    expect(normalized).toContain("admin_recipient.banned = false");
    expect(normalized).toContain("source_request.status = 'pending'");
    expect(normalized).toContain("source_request.adult_confirmed_at is not null");
    expect(normalized).toContain("source_request.decided_by is null");
    expect(normalized).toContain("source_request.decision_reason is null");
    expect(normalized).toContain("source_request.decided_at is null");
    expect(compact).toContain("${outbox}.variables ->> 'name' = 'Administrator'");
    expect(normalized).toContain("adminaccessurlparameter");

    expect(compact).toContain("${outbox}.variables ->> '_mailProducer' = 'access-request-approved'");
    expect(normalized).toContain("source_invitation.access_request_id = source_request.id");
    expect(normalized).toContain("source_request.status = 'approved'");
    expect(normalized).toContain("source_invitation.created_by = source_request.decided_by");
    expect(normalized).toContain("approvedinvitationtokenhashparameter");
    expect(normalized).toContain("source_invitation.expires_at > pg_catalog.statement_timestamp()");
    expect(normalized).toContain("source_invitation.consumed_at is null");

    expect(compact).toContain("${outbox}.variables ->> '_mailProducer' = 'access-request-rejected'");
    expect(normalized).toContain("source_request.status = 'rejected'");
    expect(normalized).toContain("source_request.decided_by is not null");
    expect(normalized).toContain("source_request.decision_reason is not null");
    expect(normalized).toContain("source_request.decided_at is not null");
    expect(normalized).toContain("not (${outbox}.variables ? 'url')");
  });

  it("keeps one producer/template/source truth table for every boundary CAS", () => {
    expect(source).toContain("function systemMailAuthorityPredicate");
    expect(source).toContain("SUPPRESSION_SYSTEM_MAIL_AUTHORITY_SQL");
    expect(source).toContain("BOUNDARY_SYSTEM_MAIL_AUTHORITY_SQL");
    expect(normalized).toContain("not (${suppression_system_mail_authority_sql})");
    expect(normalized).toContain("${boundary_system_mail_authority_sql}");
    expect((compact.match(/_mailSourceId/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(compact).not.toContain("'_mailProducer' IN (");
  });

  it("locks live source rows while preserving deletion evidence parameter slots", () => {
    expect(normalized).toContain("lockauthorityrows");
    expect(normalized).toContain("for share of account_user");
    expect(normalized).toContain("for share of source_invitation, source_request");
    expect(normalized).toContain("for share of source_request, admin_recipient");
    expect(source).toContain("validParameter: 14");
    expect(source).toContain("validParameter: 15");
    expect(source).toContain("validParameter: 16");
    expect(source).toContain("approvedInvitationTokenHashParameter: 17");
    expect(source).toContain("adminAccessUrlParameter: 18");
  });


  it("binds the provider permit to the exact claimed payload", () => {
    expect(normalized).toContain("outbox.to_email = lower(btrim($8::text))");
    expect(normalized).toContain("outbox.template = $9::text");
    expect(normalized).toContain("outbox.template_version = $10::text");
    expect(normalized).toContain("outbox.variables = $11::jsonb");
  });
});
