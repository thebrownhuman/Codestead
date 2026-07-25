import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const migrationPath = resolve(
  repositoryRoot,
  "drizzle",
  "0066_mail_outbox_provider_correlation_evidence.sql",
);
const migration = existsSync(migrationPath)
  ? readFileSync(migrationPath, "utf8")
  : "";
const normalized = migration.toLowerCase().replace(/\s+/gu, " ");

describe("0066 email outbox provider correlation evidence", () => {
  it("locks and rejects malformed predecessor state before adding columns", () => {
    const lock = normalized.indexOf(
      "lock table public.email_outbox in access exclusive mode",
    );
    const preflight = normalized.indexOf(
      "email outbox provider correlation predecessor state is invalid",
    );
    const addCorrelation = normalized.indexOf(
      'add column "provider_correlation_version" text',
    );
    const addEvidenceVersion = normalized.indexOf(
      'add column "provider_evidence_version" text',
    );
    const addEvidence = normalized.indexOf(
      'add column "provider_evidence_sha256" text',
    );

    expect(lock).toBeGreaterThanOrEqual(0);
    expect(preflight).toBeGreaterThan(lock);
    expect(addCorrelation).toBeGreaterThan(preflight);
    expect(addEvidenceVersion).toBeGreaterThan(addCorrelation);
    expect(addEvidence).toBeGreaterThan(addEvidenceVersion);
    expect(normalized).toContain("errcode = '23514'");
  });

  it("proves the exact reviewed 0064 catalog before mutating the table", () => {
    expect(normalized).toContain(
      "pg_catalog.pg_get_userbyid(routine.proowner) = 'learncoding_owner'",
    );
    expect(normalized).toContain(
      "language.lanname = 'plpgsql'",
    );
    expect(normalized).toContain(
      "routine.proconfig is not distinct from array['search_path=pg_catalog']::text[]",
    );
    expect(normalized).toContain(
      "e03d2be2455d53f9ddd0c0b7a8029efd07186a4d6804b86c2206b29031da7fdf",
    );
    expect(normalized).toContain(
      "b3ba15cae78eaf8e3535b28c0764e9715683e15ab85b0814089e3e54715f4676",
    );
    expect(normalized).toContain(
      "array['learncoding_owner|execute|false']::text[]",
    );
    expect(normalized).toContain(
      "trigger.tgname = 'email_outbox_dispatch_binding_guard'",
    );
    expect(normalized).toContain("trigger.tgenabled = 'o'");
    expect(normalized).toContain("trigger.tgtype = 23");
    expect(normalized).toContain(
      "constraint_record.conname = 'email_outbox_dispatch_binding_valid'",
    );
    expect(normalized).toContain(
      "dispatch_binding_version=''gmail-raw-v1''::text",
    );
    expect(normalized).toContain(
      "array['learncoding_worker|update|false']::text[]",
    );
  });

  it("classifies only real provider evidence and the exact 0057 ambiguous exception", () => {
    expect(normalized).toContain(
      "set provider_correlation_version = 'legacy-raw-v0'",
    );
    expect(normalized).toContain("provider_call_started is not null");
    expect(normalized).toContain(
      "last_error_code = 'legacy_sending_ambiguous'",
    );
    expect(normalized).toContain("provider_call_started is null");
    expect(normalized).toContain("adapter is null");
    expect(normalized).toContain("provider_message_id is null");
    expect(normalized).toContain("claim_version = 0");
    expect(normalized).not.toMatch(
      /set provider_correlation_version = 'opaque-sha256-v1'/u,
    );
    expect(normalized).not.toMatch(
      /provider_(?:correlation_version|evidence_version|evidence_sha256)" text (?:default|not null)/u,
    );
  });

  it("enforces exact disjoint legacy and new-provider state unions", () => {
    expect(normalized).toContain(
      'constraint "email_outbox_provider_correlation_evidence_valid"',
    );
    expect(normalized).toMatch(
      /constraint "email_outbox_provider_correlation_evidence_valid" check \(\([\s\S]*\) is true\) not valid/u,
    );
    expect(normalized).toContain(
      "provider_call_started is null and adapter is null and provider_message_id is null and last_error_code is distinct from 'legacy_sending_ambiguous' and dispatch_binding_version is null and dispatch_binding_sha256 is null and provider_correlation_version is null and provider_evidence_version is null and provider_evidence_sha256 is null",
    );
    expect(normalized).toContain(
      "provider_call_started is not null and adapter in ('gmail', 'console')",
    );
    expect(normalized).toContain(
      "provider_correlation_version = 'legacy-raw-v0' and provider_evidence_version is null and provider_evidence_sha256 is null",
    );
    expect(normalized).toContain(
      "provider_correlation_version = 'opaque-sha256-v1'",
    );
    expect(normalized).toContain(
      "dispatch_binding_version = 'gmail-raw-v1'",
    );
    expect(normalized).toContain(
      "provider_evidence_version = 'gmail-header-evidence-v1'",
    );
    expect(normalized).toContain(
      "provider_evidence_sha256 ~ '^[0-9a-f]{64}$'",
    );
    expect(normalized).toContain(
      "dispatch_binding_version = 'console-json-v1'",
    );
    expect(normalized).toContain(
      "provider_evidence_version is null and provider_evidence_sha256 is null",
    );
    expect(normalized).toContain(
      "last_error_code = 'legacy_sending_ambiguous'",
    );
    expect(normalized).toContain(
      "validate constraint email_outbox_provider_correlation_evidence_valid",
    );
  });

  it("preserves the exact 0064 dispatch constraint, function, and trigger", () => {
    expect(normalized).not.toContain(
      "drop constraint email_outbox_dispatch_binding_valid",
    );
    expect(normalized).not.toContain(
      'constraint "email_outbox_dispatch_binding_valid"',
    );
    expect(normalized).not.toContain(
      'create or replace function "public"."enforce_email_outbox_dispatch_binding"()',
    );
    expect(normalized).not.toContain(
      'drop function "public"."enforce_email_outbox_dispatch_binding"()',
    );
    expect(normalized).not.toContain(
      'drop trigger "email_outbox_dispatch_binding_guard"',
    );
  });

  it("permits only the worker's exact null-to-v1 provider-arm transition", () => {
    expect(normalized).toContain(
      'create function "public"."enforce_email_outbox_provider_correlation_evidence"()',
    );
    expect(normalized).toContain("security invoker");
    expect(normalized).toContain("set search_path = pg_catalog");
    expect(normalized).toContain(
      "current_user <> 'learncoding_worker' or session_user <> 'learncoding_worker'",
    );
    expect(normalized).toContain(
      "new.provider_correlation_version = 'opaque-sha256-v1'",
    );
    expect(normalized).toContain(
      "new.provider_call_started = pg_catalog.statement_timestamp()",
    );
    expect(normalized).toContain(
      "old.dispatch_binding_version is null",
    );
    expect(normalized).toContain(
      "new.dispatch_binding_version in ('gmail-raw-v1', 'console-json-v1')",
    );
    expect(normalized).toContain(
      "old.provider_call_started is not distinct from new.provider_call_started",
    );
    expect(normalized).toContain(
      "old.dispatch_binding_sha256 is not distinct from new.dispatch_binding_sha256",
    );
    expect(normalized).toContain(
      "email outbox provider correlation evidence is immutable",
    );
    expect(normalized).not.toContain(
      "new.provider_correlation_version = 'legacy-raw-v0'",
    );
  });

  it("owns and seals the trigger while recording exact direct column ACLs", () => {
    expect(normalized).toContain(
      'alter function "public"."enforce_email_outbox_provider_correlation_evidence"() owner to learncoding_owner',
    );
    expect(normalized).toContain(
      "cross join lateral pg_catalog.aclexplode( coalesce( routine.proacl, pg_catalog.acldefault('f', routine.proowner) ) )",
    );
    expect(normalized).not.toContain(
      "expanded.grantee <> routine.proowner",
    );
    expect(normalized).toContain(
      "'from %i cascade', candidate_name",
    );
    expect(normalized).toContain(
      "do $verify_provider_authority_acl$",
    );
    expect(normalized).toContain(
      'grant execute on function "public"."enforce_email_outbox_provider_correlation_evidence"() to learncoding_owner',
    );
    expect(normalized).toContain(
      "cross join lateral pg_catalog.aclexplode( attribute.attacl )",
    );
    expect(normalized).toContain(
      "attribute.attname = any (array[ 'provider_correlation_version', 'provider_evidence_version', 'provider_evidence_sha256' ]::pg_catalog.name[])",
    );
    expect(normalized).not.toContain(
      "learncoding_backup_reporter",
    );
    expect(normalized).not.toContain(
      "grant select ( provider_correlation_version",
    );
    expect(normalized).toContain(
      "grant update ( provider_correlation_version, provider_evidence_version, provider_evidence_sha256 ) on table public.email_outbox to learncoding_worker",
    );
    expect(normalized).not.toMatch(
      /grant insert \([^)]*provider_(?:correlation|evidence)/u,
    );
  });

  it("updates schema without inventing journal continuity before 0065 lands", () => {
    const schema = readFileSync(
      resolve(repositoryRoot, "src", "lib", "db", "schema.ts"),
      "utf8",
    );
    const journal = readFileSync(
      resolve(repositoryRoot, "drizzle", "meta", "_journal.json"),
      "utf8",
    );

    expect(schema).toContain(
      'providerCorrelationVersion: text("provider_correlation_version")',
    );
    expect(schema).toContain(
      'providerEvidenceVersion: text("provider_evidence_version")',
    );
    expect(schema).toContain(
      'providerEvidenceSha256: text("provider_evidence_sha256")',
    );
    expect(schema).toContain(
      '"email_outbox_provider_correlation_evidence_valid"',
    );
    expect(journal).not.toContain(
      '"tag": "0066_mail_outbox_provider_correlation_evidence"',
    );
    expect(existsSync(resolve(
      repositoryRoot,
      "drizzle",
      "meta",
      "0066_snapshot.json",
    ))).toBe(false);
  });
});
