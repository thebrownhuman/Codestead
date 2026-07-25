import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const publishedMigrationPath = resolve(
  process.cwd(),
  "drizzle",
  "0062_mail_outbox_retention_redaction.sql",
);
const migrationPath = resolve(
  process.cwd(),
  "drizzle",
  "0063_mail_outbox_redaction_fence_release.sql",
);
const migration = existsSync(migrationPath)
  ? readFileSync(migrationPath, "utf8").toLowerCase()
  : "";
const retention = readFileSync(
  resolve(process.cwd(), "src/lib/data-lifecycle/retention.ts"),
  "utf8",
).toLowerCase();

describe("0063 mail outbox retention redaction fence release", () => {
  it("keeps published 0062 intact and registers a forward migration", () => {
    const journal = JSON.parse(
      readFileSync(resolve(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };

    expect(existsSync(publishedMigrationPath)).toBe(true);
    expect(existsSync(migrationPath)).toBe(true);
    const entryIndex = journal.entries.findIndex(
      (entry) => entry.tag === "0063_mail_outbox_redaction_fence_release",
    );
    expect(entryIndex).toBeGreaterThan(0);
    expect(journal.entries[entryIndex]).toEqual({
      ...journal.entries[entryIndex],
      idx: 63,
      tag: "0063_mail_outbox_redaction_fence_release",
    });
    expect(journal.entries[entryIndex - 1]).toMatchObject({
      idx: 62,
      tag: "0062_mail_outbox_retention_redaction",
    });
    expect(new Set(journal.entries.map((entry) => entry.idx)).size).toBe(journal.entries.length);
    expect(new Set(journal.entries.map((entry) => entry.tag)).size).toBe(journal.entries.length);
  });

  it("defines one private owner predicate and keeps the mutator ops-only", () => {
    expect(migration).toContain(
      'create or replace function "public"."classify_email_outbox_retention_redaction"',
    );
    expect(migration).toContain("security definer");
    expect(migration).toContain("set search_path = pg_catalog");
    expect(migration).toMatch(
      /alter function "public"\."classify_email_outbox_retention_redaction"[\s\S]+owner to learncoding_owner/u,
    );
    expect(migration).toMatch(
      /revoke all on function "public"\."classify_email_outbox_retention_redaction"[\s\S]+from public,\s*learncoding_app,\s*learncoding_worker,\s*learncoding_migrator,\s*learncoding_ops/u,
    );
    expect(migration).not.toMatch(
      /grant execute on function "public"\."classify_email_outbox_retention_redaction"\s*\(/u,
    );
    expect(migration).toContain(
      'create or replace function "public"."redact_unresolved_email_outbox_authority"',
    );
    expect(migration).toContain(
      'alter function "public"."redact_unresolved_email_outbox_authority"',
    );
    expect(migration).toContain("owner to learncoding_owner");
    expect(migration).not.toContain("statement-breakpointalter function");
    expect(migration).toMatch(
      /revoke all on function[\s\S]+from public,\s*learncoding_app,\s*learncoding_worker,\s*learncoding_migrator,\s*learncoding_ops/u,
    );
    expect(migration).toMatch(
      /grant execute on function[\s\S]+to learncoding_ops/u,
    );
    expect(migration).toContain("session_user <> 'learncoding_ops'");
    expect(migration).toContain("current_user <> 'learncoding_owner'");
    expect(migration).toContain(
      "raise exception 'email outbox redaction caller is not authorized'",
    );
  });

  it("classifies only fully released rows as eligible and exposes held or malformed backlog", () => {
    for (const fragment of [
      "candidate.claim_token is null",
      "candidate.claim_owner is null",
      "candidate.lease_expires_at is null",
      "candidate.claim_token is not null",
      "candidate.claim_owner is not null",
      "candidate.lease_expires_at is not null",
      "candidate.quarantined_at is null",
      "nullif(pg_catalog.btrim(candidate.last_error_code), '') is null",
      "return 'eligible_account'",
      "return 'eligible_system'",
      "return 'blocked'",
      "return 'malformed'",
    ]) expect(migration).toContain(fragment);
    expect(migration).not.toContain(
      "candidate.lease_expires_at <= pg_catalog.statement_timestamp()",
    );
    expect(migration).toContain(
      'returns table("disposition" text, "eligible" bigint, "transitioned" bigint)',
    );
    expect(migration).toContain("values ('eligible'), ('blocked'), ('malformed')");
    expect(migration).toContain("report_only boolean := batch_limit = 0");
    expect(migration).toContain("batch_limit < 0");
    const reportBranchStart = migration.indexOf("if report_only then");
    const reportBranchEnd = migration.indexOf("return;", reportBranchStart);
    const updateStart = migration.indexOf("update public.email_outbox as outbox");
    expect(reportBranchStart).toBeGreaterThanOrEqual(0);
    expect(reportBranchEnd).toBeGreaterThan(reportBranchStart);
    expect(updateStart).toBeGreaterThan(reportBranchEnd);
    const reportBranch = migration.slice(reportBranchStart, reportBranchEnd);
    expect(reportBranch).toContain(
      '"public"."classify_email_outbox_retention_redaction"(candidate, cutoff_at)',
    );
    expect(reportBranch).toContain("0::bigint as transitioned");
    expect(reportBranch).not.toContain("for update");
    expect(reportBranch).not.toContain("update public.email_outbox");
  });

  it("redacts system envelopes to the exact four-key constraint-valid authority shell", () => {
    for (const fragment of [
      "candidate.user_id is null",
      "candidate.delivery_scope_key is not distinct from 's:' || candidate.operation_id::text",
      "candidate.variables ->> '_mailoperationid' is distinct from candidate.operation_id::text",
      "candidate.variables ->> '_mailrecipient' is distinct from candidate.to_email",
      "candidate.variables ->> '_mailsourceid'",
      "candidate.variables ->> '_mailproducer'",
      "candidate.template = 'access-request-admin'",
      "candidate.template = 'invitation'",
      "candidate.template = 'access-rejected'",
    ]) expect(migration).toContain(fragment);
    expect(migration).toContain("return 'eligible_system'");
    for (const key of [
      "'_mailoperationid'",
      "'_mailrecipient'",
      "'_mailproducer'",
      "'_mailsourceid'",
    ]) expect(migration).toContain(key);
    expect(migration).toContain("pg_catalog.jsonb_build_object(");
    expect(migration).toContain("new.variables = expected_variables");
  });

  it("reuses the classifier in the trigger exception and the reporting mutator", () => {
    expect(migration).toContain(
      'redaction_disposition := "public"."classify_email_outbox_retention_redaction"(',
    );
    expect(migration).toContain("pg_catalog.statement_timestamp() - interval '30 days'");
    expect(migration).toContain(
      '"public"."classify_email_outbox_retention_redaction"(candidate, cutoff_at)',
    );
    expect(migration).toContain(
      'create or replace function "public"."enforce_email_outbox_payload_immutable"()',
    );
    for (const fragment of [
      "current_user = 'learncoding_owner'",
      "session_user = 'learncoding_ops'",
      "new.adapter = 'gmail'",
      "expected_email := 'redacted+' || old.id::text || '@invalid.local'",
      "new.variables = expected_variables",
      "new.updated_at = pg_catalog.statement_timestamp()",
    ]) expect(migration).toContain(fragment);
    for (const field of [
      "id",
      "user_id",
      "template",
      "template_version",
      "idempotency_key",
      "operation_id",
      "delivery_scope_key",
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
      "created_at",
    ]) expect(migration).toContain(`old.${field} is not distinct from new.${field}`);
  });

  it("redacts only PII and preserves reconciliation and fence evidence", () => {
    const updateStart = migration.indexOf("update public.email_outbox as outbox");
    const updateEnd = migration.indexOf("returning outbox.id", updateStart);
    expect(updateStart).toBeGreaterThanOrEqual(0);
    expect(updateEnd).toBeGreaterThan(updateStart);
    const update = migration.slice(updateStart, updateEnd);

    expect(update).toContain(
      "set to_email = 'redacted+' || outbox.id::text || '@invalid.local'",
    );
    expect(update).toContain("variables = case when outbox.user_id is null");
    expect(update).toContain("else '{}'::jsonb");
    expect(update).toContain("pg_catalog.jsonb_build_object(");
    expect(update).toContain("updated_at = pg_catalog.statement_timestamp()");
    expect(update).not.toContain("->> 'name'");
    expect(update).not.toContain("->> 'url'");
    for (const evidence of [
      "claim_token =",
      "claim_owner =",
      "claim_version =",
      "lease_expires_at =",
      "provider_call_started =",
      "provider_message_id =",
      "quarantined_at =",
      "last_error_code =",
    ]) expect(update).not.toContain(evidence);
  });

  it("routes reporting through the capability without duplicating raw eligibility SQL", () => {
    expect(retention).toContain(
      "from public.redact_quarantined_email_outbox_authority_v2(",
    );
    expect(retention).not.toContain(
      "update email_outbox\n              set to_email = 'redacted+'",
    );
    expect(retention).not.toContain("const unresolvedemailauthorityeligible = await count(");
    expect(retention).not.toContain("and lease_expires_at <= statement_timestamp()");
    expect(retention).toContain("unresolvedemaildeliveryauthorityblocked");
    expect(retention).toContain("unresolvedemaildeliveryauthoritymalformed");
  });
});
