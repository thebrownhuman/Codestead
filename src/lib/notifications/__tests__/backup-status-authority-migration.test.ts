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
      "outbox_id",
      "operation_id",
      "authority_epoch",
      "created_at",
    ]) {
      expect(migration).toContain(`"${column}"`);
    }
    expect(migration).not.toContain("recipient_user_id");
    expect(migration).not.toMatch(
      /create table "public"\."backup_status_mail_authority"[\s\S]*"recipient_email"/u,
    );
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

  it("binds authority to an opaque, irreversibly rotated admin generation", () => {
    expect(migration).toMatch(
      /create table "public"\."backup_status_mail_authority"[\s\S]*"authority_epoch" uuid not null/u,
    );
    expect(migration).toMatch(
      /create table "public"\."backup_status_mail_admin_guard"[\s\S]*"authority_epoch" uuid\s+default pg_catalog\.gen_random_uuid\(\) not null/u,
    );
    for (const constraint of [
      "backup_status_mail_authority_epoch_valid",
      "backup_status_mail_admin_guard_epoch_valid",
    ]) {
      expect(migration).toContain(`constraint "${constraint}"`);
    }
    expect(migration).toMatch(
      /update public\.backup_status_mail_admin_guard\s+set authority_epoch = pg_catalog\.gen_random_uuid\(\)/u,
    );
    expect(
      migration.match(/source\.authority_epoch = current_authority_epoch/gu),
    ).toHaveLength(3);
    expect(migration).toContain("selected_authority_epoch");
    expect(migration).toMatch(
      /insert into public\.backup_status_mail_authority \([\s\S]*authority_epoch[\s\S]*selected_authority_epoch/u,
    );
    const outboxInsertStart = migration.indexOf("insert into public.email_outbox");
    const outboxInsert = migration.slice(
      outboxInsertStart,
      migration.indexOf("insert into public.backup_status_mail_authority", outboxInsertStart),
    );
    expect(outboxInsert).not.toContain("authority_epoch");
    expect(outboxInsert).not.toContain("recipient_email");
  });

  it("exposes only the fixed reporter enqueue and worker predicate capabilities", () => {
    expect(migration).toMatch(
      /"enqueue_backup_status_mail_authority"\(\s*"p_run_key" text,\s*"p_outcome" text\s*\)/u,
    );
    expect(migration).toMatch(
      /"backup_status_mail_authorized"\(\s*"p_candidate_outbox_id" uuid\s*\)/u,
    );
    expect(migration.match(/security definer/gu)).toHaveLength(3);
    expect(migration.match(/set search_path = pg_catalog/gu)).toHaveLength(4);
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
      "coalesce(admin_recipient.banned, false) = false",
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
    expect(migration).toContain("candidate.user_id = admin_recipient.id");
    expect(migration).toContain(
      "candidate.delivery_scope_key =\n         'a:' || candidate.user_id",
    );
    expect(migration).toContain(
      "hinted_admin_id,\n    'a:' || hinted_admin_id",
    );
    const enqueue = migration.slice(
      migration.indexOf('create function "public"."enqueue_backup_status_mail_authority"'),
      migration.indexOf('alter function "public"."enqueue_backup_status_mail_authority"'),
    );
    const authorityHintLock = enqueue.indexOf("'user-authority:' || hinted_admin_id");
    const sameRunLock = enqueue.indexOf("'backup-status-authority:' || p_run_key");
    const durableRecipientRevalidation = enqueue.indexOf(
      "selected_admin_id is distinct from hinted_admin_id",
    );
    expect(authorityHintLock).toBeGreaterThanOrEqual(0);
    expect(sameRunLock).toBeGreaterThan(authorityHintLock);
    expect(durableRecipientRevalidation).toBeGreaterThan(sameRunLock);
    expect(migration).not.toContain(
      'drop constraint "email_outbox_delivery_scope_valid"',
    );
    expect(migration).not.toContain("'s:' || new_operation_id::text");
  });

  it("serializes only administrator-authority changes", () => {
    expect(migration).not.toMatch(/lock table public\."user"/u);
    expect(migration).toContain(
      'create table "public"."backup_status_mail_admin_guard"',
    );
    expect(migration).toContain(
      'create function "public"."lock_backup_status_mail_admin_authority"()',
    );
    for (const trigger of [
      "backup_status_mail_admin_insert_lock",
      "backup_status_mail_admin_update_lock",
      "backup_status_mail_admin_delete_lock",
    ]) {
      expect(migration).toContain(`create trigger "${trigger}"`);
    }
    expect(migration).toContain(
      'before update of id, email, role, status, banned on "public"."user"',
    );
    expect(migration).toContain(
      "old.id is distinct from new.id",
    );
    expect(migration).toContain(
      "raise exception 'user identifier is immutable'",
    );
    expect(migration).toContain(
      "set authority_epoch = pg_catalog.gen_random_uuid()",
    );
    expect(migration.match(/for share of authority_guard/gu)).toHaveLength(3);
    expect(migration).not.toContain(
      "for share of source, candidate, admin_recipient",
    );
    const assertCanonicalAccountLockOrder = (functionSql: string) => {
      const positions = [
        functionSql.indexOf("for share of locked_recipient"),
        functionSql.indexOf("for share of locked_candidate"),
        functionSql.indexOf("for share of locked_source"),
        functionSql.indexOf(
          "from public.backup_status_mail_admin_guard as authority_guard",
        ),
      ];
      expect(positions.every((position) => position >= 0)).toBe(true);
      expect(positions).toEqual([...positions].sort((left, right) => left - right));
    };
    const enqueue = migration.slice(
      migration.indexOf('create function "public"."enqueue_backup_status_mail_authority"'),
      migration.indexOf('alter function "public"."enqueue_backup_status_mail_authority"'),
    );
    const predicate = migration.slice(
      migration.indexOf('create function "public"."backup_status_mail_authorized"'),
      migration.indexOf('alter function "public"."backup_status_mail_authorized"'),
    );
    assertCanonicalAccountLockOrder(enqueue);
    assertCanonicalAccountLockOrder(predicate);
    expect(migration).toContain("revalidated_admin_count <> 1");
  });

  it("serializes same-run replay and revalidates every source field under locks", () => {
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("hashtextextended");
    expect(migration).not.toMatch(/lock table public\."user"/u);
    expect(migration).toContain("backup status mail replay conflicts");
    for (const fragment of [
      "source.outcome = requested_outcome",
      "source.outbox_id = candidate.id",
      "source.operation_id = candidate.operation_id",
      "candidate.user_id = admin_recipient.id",
      "candidate.delivery_scope_key =",
      "candidate.template = 'backup-status'",
      "candidate.template_version = '1'",
      "candidate.variables = pg_catalog.jsonb_build_object",
      "admin_recipient.role = 'admin'",
      "admin_recipient.status = 'active'",
      "coalesce(admin_recipient.banned, false) = false",
      "pg_catalog.lower(pg_catalog.btrim(admin_recipient.email)) =",
    ]) {
      expect(migration).toContain(fragment);
    }
    expect(migration).toContain("requested_outcome text := p_outcome");
    expect(migration).toContain("source.run_key = p_run_key");
    expect(migration).toContain("candidate.id = p_candidate_outbox_id");
    expect(migration).not.toMatch(
      /source\.run_key\s*=\s*"run_key"|candidate\.id\s*=\s*candidate_outbox_id/u,
    );
    expect(migration).not.toContain('requested_outcome text := "outcome"');
    expect(migration).not.toContain("source.recipient_email");
    for (const lockedAlias of [
      "locked_recipient", "locked_candidate", "locked_source",
    ]) {
      expect(migration).toContain(`for share of ${lockedAlias}`);
    }
  });
});
