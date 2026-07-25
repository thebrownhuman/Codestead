import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "drizzle",
  "0068_mail_outbox_quarantine_redaction_authority_v2.sql",
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

describe("0068 quarantined mail payload-redaction authority v2", () => {
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

  it("ages on quarantine evidence without depending on provider receipt completeness", () => {
    expect(migration).toMatch(
      /coalesce\(\s*candidate\.quarantined_at,\s*candidate\.updated_at,\s*candidate\.created_at\s*\)/u,
    );

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

  it("redacts every partial claim tuple and blocks only a complete held tuple", () => {
    expect(migration).toContain(
      "claim_authority_parts := pg_catalog.num_nonnulls(",
    );
    expect(migration).toContain("if claim_authority_parts = 0 then");
    expect(migration).toContain(
      "if claim_authority_parts between 1 and 2 then",
    );
    expect(migration).toMatch(
      /if claim_authority_parts between 1 and 2 then[\s\S]*?return raw_disposition;/u,
    );
    expect(migration).toMatch(
      /if claim_authority_parts = 3[\s\S]*?candidate\.lease_expires_at\s*>\s*pg_catalog\.statement_timestamp\(\)[\s\S]*?return 'blocked';/u,
    );
    expect(migration).toMatch(
      /return 'blocked';[\s\S]*?return raw_disposition;/u,
    );
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
    for (const predecessorProof of [
      "pg_catalog.pg_get_functiondef",
      "routine.prosrc",
      "routine.prosecdef",
      "routine.proconfig",
      "acl.grantor",
      "trigger_record.tgtype = 23",
      "trigger_record.tgqual is null",
      "trigger_record.tgnargs = 0",
      "trigger_record.tgattr = ''::pg_catalog.int2vector",
      "constraint_record.conkey",
      "pg_catalog.pg_get_expr",
      "cc196df96da9024d65c85ef3451eae1f1dd059672226ba8c37c2e7d2af374bd9",
      "fa3258f9172adbefc2cbb58a57d63533f8933811c77d0d3eb1b285f6bd2dd4da",
      "pg_catalog.pg_get_constraintdef",
      "pg_catalog.to_jsonb(constraint_record)",
      "conenforced",
      "attribute.attacl",
      "relation.relowner",
      "relation.relrowsecurity",
      "relation.relforcerowsecurity",
      "relation.relispartition",
      "relation.reloftype",
      "relation.relhassubclass",
      "relation.relhasrules",
      "pg_catalog.pg_inherits",
      "pg_catalog.pg_rewrite",
      "pg_catalog.has_table_privilege",
      "attribute.attcollation",
      "trigger_record.tgparentid",
      "trigger_record.tgconstraint",
    ]) {
      expect(migration, predecessorProof).toContain(predecessorProof);
    }
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
    expect(migration).not.toContain("expanded.grantee <> routine.proowner");
    expect(
      migration.match(/from learncoding_owner cascade/gu),
    ).toHaveLength(3);
    expect(
      migration.match(/to learncoding_owner/gu)?.length ?? 0,
    ).toBeGreaterThanOrEqual(3);
    expect(migration.match(/from public cascade/gu)).toHaveLength(3);
    expect(migration.match(/from %i cascade/gu)).toHaveLength(3);
    expect(migration).toContain(
      "lock table only public.email_outbox in access exclusive mode",
    );
    expect(migration).toMatch(
      /drop trigger if exists "email_outbox_payload_immutable"\s+on public\.email_outbox/u,
    );
    const repairedTrigger = migration
      .split("--> statement-breakpoint")
      .find((statement) =>
        statement.includes('create trigger "email_outbox_payload_immutable"'),
      ) ?? "";
    expect(repairedTrigger).toContain("before update of");
    for (const column of [
      "user_id",
      "to_email",
      "template",
      "template_version",
      "variables",
      "idempotency_key",
      "operation_id",
      "delivery_scope_key",
    ]) {
      expect(repairedTrigger).toContain(`"${column}"`);
    }
  });

  it("gates terminal quarantined deletion behind durable coverage", () => {
    expect(retention).toContain(
      "from public.redact_quarantined_email_outbox_authority_v2(",
    );
    expect(retention).not.toContain(
      "from public.redact_unresolved_email_outbox_authority(",
    );
    const fragments = terminalEmailFragments();
    for (const fragment of Object.values(fragments)) {
      expect(fragment).toContain("status in ('sent', 'suppressed', 'failed')");
      expect(fragment).toContain("'quarantined'");
    }
    expect(retention).toContain(
      "public.email_outbox_idempotency_coverage_authority(",
    );
    expect(fragments.delete).toContain("and id = any($3::uuid[])");
  });

  it("allows malformed PII transition counts while keeping held authority non-mutating", () => {
    expect(retention).not.toContain(
      "parseredactioncount(malformed.transitioned) !== 0",
    );
    expect(retention).toContain(
      "result.malformedtransitioned",
    );
    expect(retention).toContain(
      "malformed recipient payload would be redacted while retaining non-pii authority state",
    );
  });
});
