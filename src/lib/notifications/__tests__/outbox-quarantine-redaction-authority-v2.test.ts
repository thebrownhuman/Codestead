import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "drizzle",
  "0067_mail_outbox_quarantine_redaction_authority_v2.sql",
);
const migration = existsSync(migrationPath)
  ? readFileSync(migrationPath, "utf8").toLowerCase()
  : "";
const retention = readFileSync(
  resolve(process.cwd(), "src/lib/data-lifecycle/retention.ts"),
  "utf8",
).toLowerCase();

function terminalEmailFragments() {
  const countStart = retention.indexOf("const emaileligible = await count(");
  const countEnd = retention.indexOf("const oldaudit = await count(", countStart);
  const deleteStart = retention.indexOf(
    "const deletedemail = await client.query<idrow>(",
  );
  const deleteEnd = retention.indexOf(
    "categories.terminalemaildeliveryrecords =",
    deleteStart,
  );

  expect(countStart).toBeGreaterThanOrEqual(0);
  expect(countEnd).toBeGreaterThan(countStart);
  expect(deleteStart).toBeGreaterThanOrEqual(0);
  expect(deleteEnd).toBeGreaterThan(deleteStart);
  return {
    count: retention.slice(countStart, countEnd),
    delete: retention.slice(deleteStart, deleteEnd),
  };
}

describe("0067 quarantined mail payload-redaction authority v2", () => {
  it("is a forward SQL component whose journal metadata remains integration-owned", () => {
    expect(existsSync(migrationPath)).toBe(true);
    expect(migration).toMatch(
      /create(?: or replace)? function\s+"public"\."classify_email_outbox_quarantine_redaction_v2"/u,
    );
    expect(migration).toMatch(
      /create(?: or replace)? function\s+"public"\."redact_quarantined_email_outbox_authority_v2"/u,
    );
  });

  it("uses one classifier for reporting, locked selection, CAS revalidation, and the trigger carve-out", () => {
    const classifierCall =
      '"public"."classify_email_outbox_quarantine_redaction_v2"';
    expect(migration.split(classifierCall).length - 1).toBeGreaterThanOrEqual(5);
    expect(migration).toContain("as raw_disposition");
    expect(migration).toContain("for update of candidate skip locked");
    expect(migration).toContain("redaction_disposition :=");
    expect(migration).toContain("classified.raw_disposition in (");
    expect(migration).toMatch(
      /where outbox\.id = eligible_rows\.id[\s\S]+classify_email_outbox_quarantine_redaction_v2/u,
    );
  });

  it("ages on quarantine evidence, releases only an empty fence, and does not depend on provider receipt completeness", () => {
    expect(migration).toMatch(
      /coalesce\(\s*candidate\.quarantined_at,\s*candidate\.updated_at,\s*candidate\.created_at\s*\)/u,
    );
    expect(migration).toContain("candidate.claim_token is null");
    expect(migration).toContain("candidate.claim_owner is null");
    expect(migration).toContain("candidate.lease_expires_at is null");
    expect(migration).toContain("return 'blocked'");

    const classifierStart = migration.indexOf(
      'create or replace function "public"."classify_email_outbox_quarantine_redaction_v2"',
    );
    const classifierEnd = migration.indexOf("$function$;", classifierStart);
    const classifier = migration.slice(classifierStart, classifierEnd);
    expect(classifier).not.toContain("provider_message_id is null");
    expect(classifier).not.toContain("provider_evidence_sha256 ~");
    expect(classifier).not.toContain("adapter = 'gmail'");
  });

  it("redacts valid account/system/operation scopes and malformed scopes without changing authority", () => {
    for (const disposition of [
      "eligible_account",
      "eligible_system",
      "eligible_operation",
      "eligible_malformed",
    ]) {
      expect(migration).toContain(`'${disposition}'`);
    }
    expect(migration).toMatch(
      /set to_email\s*=\s*'redacted\+'\s*\|\|\s*outbox\.id::text\s*\|\|\s*'@invalid\.local'/u,
    );
    expect(migration).toContain("variables = case");
    expect(migration).toContain("when eligible_rows.raw_disposition = 'eligible_system'");

    const updateStart = migration.indexOf("update public.email_outbox as outbox");
    const updateEnd = migration.indexOf("returning outbox.id", updateStart);
    const update = migration.slice(updateStart, updateEnd);
    for (const protectedColumn of [
      "status",
      "attempt_count",
      "claim_token",
      "claim_owner",
      "claim_version",
      "lease_expires_at",
      "provider_call_started",
      "adapter",
      "dispatch_binding_version",
      "dispatch_binding_sha256",
      "provider_message_id",
      "provider_correlation_version",
      "provider_evidence_version",
      "provider_evidence_sha256",
      "next_attempt_at",
      "sent_at",
      "quarantined_at",
      "last_error_code",
      "idempotency_key",
      "operation_id",
      "delivery_scope_key",
    ]) {
      expect(update).not.toMatch(new RegExp(`\\b${protectedColumn}\\s*=`, "u"));
    }
  });

  it("binds the owner routines and ops-only mutator to an exact hardened catalog shape", () => {
    expect(migration).toContain("security definer");
    expect(migration).toContain("set search_path = pg_catalog");
    expect(migration).toContain("session_user <> 'learncoding_ops'");
    expect(migration).toContain("current_user <> 'learncoding_owner'");
    expect(migration).toMatch(
      /alter function\s+"public"\."redact_quarantined_email_outbox_authority_v2"[\s\S]+owner to learncoding_owner/u,
    );
    expect(migration).toMatch(
      /grant execute on function\s+"public"\."redact_quarantined_email_outbox_authority_v2"[\s\S]+to learncoding_ops/u,
    );
    expect(migration).toContain("from public, learncoding_app, learncoding_worker");
    expect(migration).toContain("learncoding_migrator, learncoding_ops");
    expect(migration).toContain("expanded.grantee <> routine.proowner");
  });

  it("makes the application call only v2 and never terminal-deletes a quarantine", () => {
    expect(retention).toContain(
      "from public.redact_quarantined_email_outbox_authority_v2(",
    );
    expect(retention).not.toContain(
      "from public.redact_unresolved_email_outbox_authority(",
    );
    for (const fragment of Object.values(terminalEmailFragments())) {
      expect(fragment).toContain("status in ('sent', 'suppressed', 'failed')");
      expect(fragment).not.toContain("'quarantined'");
    }
  });

  it("allows malformed PII transition counts while keeping held authority non-mutating", () => {
    expect(retention).not.toContain(
      "parseredactioncount(malformed.transitioned) !== 0",
    );
    expect(retention).toContain(
      "result.malformedtransitioned",
    );
    expect(retention).toContain(
      "non-pii delivery authority retained for explicit operator repair",
    );
  });
});
