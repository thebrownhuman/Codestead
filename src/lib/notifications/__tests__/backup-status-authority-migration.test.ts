import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "drizzle",
  "0065_backup_status_mail_authority.sql",
);
const migration = existsSync(migrationPath)
  ? readFileSync(migrationPath, "utf8").toLowerCase()
  : "";

describe("backup-status mail authority migration", () => {
  it("reserves the post-binding 0065 slot without rewriting the shared journal", () => {
    expect(existsSync(migrationPath)).toBe(true);
    expect(migration).toContain("backup_status_mail_authority");
  });

  it("creates an immutable owner-owned source ledger with no runtime DML", () => {
    expect(migration).toMatch(
      /create table "public"\."backup_status_mail_authority"/u,
    );
    for (const column of [
      "id",
      "run_key",
      "outcome",
      "recipient_user_id",
      "recipient_email",
      "outbox_id",
      "operation_id",
      "created_at",
    ]) {
      expect(migration).toContain(`"${column}"`);
    }
    expect(migration).toMatch(
      /check\s*\(\s*"run_key"\s*~\s*'\^\[0-9\]\{8\}t\[0-9\]\{6\}z\$'/u,
    );
    expect(migration).toMatch(
      /check\s*\(\s*"outcome"\s+in\s*\(\s*'success'\s*,\s*'failure'\s*\)\s*\)/u,
    );
    expect(migration).toContain(
      'create trigger "backup_status_mail_authority_immutable"',
    );
    expect(migration).toMatch(
      /create trigger "backup_status_mail_authority_no_truncate"\s+before truncate[\s\S]*for each statement/u,
    );
    expect(migration).toContain(
      "raise exception 'backup status mail authority is immutable'",
    );
    expect(migration).toMatch(
      /revoke all on table "public"\."backup_status_mail_authority"[\s\S]*from public,\s*learncoding_app,\s*learncoding_worker,\s*learncoding_migrator,\s*learncoding_ops,\s*learncoding_backup_reporter/u,
    );
    expect(migration).not.toMatch(
      /grant\s+(?:select|insert|update|delete|truncate|references|trigger)[\s\S]*backup_status_mail_authority/u,
    );
  });

  it("exposes only the fixed reporter enqueue and worker predicate capabilities", () => {
    expect(migration).toMatch(
      /"enqueue_backup_status_mail_authority"\(\s*"run_key" text,\s*"outcome" text\s*\)/u,
    );
    expect(migration).toMatch(
      /"backup_status_mail_authorized"\(\s*"candidate_outbox_id" uuid\s*\)/u,
    );
    expect(migration.match(/security definer/gu)).toHaveLength(2);
    expect(migration.match(/set search_path = pg_catalog/gu)).toHaveLength(3);
    expect(migration).toMatch(
      /alter function "public"\."enqueue_backup_status_mail_authority"\([\s\S]*owner to learncoding_owner/u,
    );
    expect(migration).toMatch(
      /grant execute on function[\s\S]*"public"\."enqueue_backup_status_mail_authority"\(text, text\)[\s\S]*to learncoding_backup_reporter/u,
    );
    expect(migration).toMatch(
      /grant execute on function "public"\."backup_status_mail_authorized"\(uuid\)[\s\S]*to learncoding_worker/u,
    );
    const enqueueGrant = migration.match(
      /grant execute on function[\s\S]*?"public"\."enqueue_backup_status_mail_authority"\(text, text\)\s*to\s+\w+/u,
    )?.[0] ?? "";
    const predicateGrant = migration.match(
      /grant execute on function "public"\."backup_status_mail_authorized"\(uuid\)\s*to\s+\w+/u,
    )?.[0] ?? "";
    expect(enqueueGrant).toMatch(/to learncoding_backup_reporter$/u);
    expect(predicateGrant).toMatch(/to learncoding_worker$/u);
  });

  it("derives one live administrator and a fixed URL-free account payload", () => {
    expect(migration).toContain("selected_admin_count <> 1");
    expect(migration).toContain("admin_recipient.role = 'admin'");
    expect(migration).toContain("admin_recipient.status = 'active'");
    expect(migration).toContain(
      "pg_catalog.coalesce(admin_recipient.banned, false) = false",
    );
    expect(migration).toContain("'backup-status'");
    expect(migration).toContain("'name', 'administrator'");
    expect(migration).toContain("'summary'");
    expect(migration).not.toContain("'url'");
    expect(migration).not.toContain("'_mailproducer'");
    expect(migration).toContain(
      "'the nightly encrypted backup completed and passed local verification. no archive is attached to this email.'",
    );
    expect(migration).toContain(
      "'the nightly encrypted backup did not complete. review the protected operations logs; no archive or log is attached to this email.'",
    );
  });

  it("uses natural account scope so 0063 can redact unresolved recipient PII", () => {
    expect(migration).toContain("candidate.user_id = source.recipient_user_id");
    expect(migration).toContain(
      "candidate.delivery_scope_key =\n         'a:' || source.recipient_user_id",
    );
    expect(migration).toContain("selected_admin_id,\n    'a:' || selected_admin_id");
    expect(migration).not.toContain(
      'drop constraint "email_outbox_delivery_scope_valid"',
    );
    expect(migration).not.toContain("'s:' || new_operation_id::text");
  });

  it("serializes same-run replay and revalidates every source field under locks", () => {
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("hashtextextended");
    expect(
      migration.match(/lock table public\."user" in share mode/gu),
    ).toHaveLength(2);
    expect(migration).toContain("backup status mail replay conflicts");
    for (const fragment of [
      "source.outcome = requested_outcome",
      "source.outbox_id = candidate.id",
      "source.operation_id = candidate.operation_id",
      "source.recipient_user_id = admin_recipient.id",
      "source.recipient_email = candidate.to_email",
      "candidate.user_id = source.recipient_user_id",
      "candidate.template = 'backup-status'",
      "candidate.template_version = '1'",
      "candidate.variables = pg_catalog.jsonb_build_object",
      "admin_recipient.role = 'admin'",
      "admin_recipient.status = 'active'",
      "pg_catalog.coalesce(admin_recipient.banned, false) = false",
      "pg_catalog.lower(pg_catalog.btrim(admin_recipient.email)) =",
    ]) {
      expect(migration).toContain(fragment);
    }
    expect(migration).toContain("for share of source, candidate, admin_recipient");
  });
});
