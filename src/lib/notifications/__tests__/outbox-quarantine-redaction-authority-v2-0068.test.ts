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

function functionBody(name: string) {
  const start = migration.search(
    new RegExp(`create(?: or replace)? function\\s+"?public"?\\."?${name}"?`, "u"),
  );
  expect(start, `${name} must exist`).toBeGreaterThanOrEqual(0);
  const end = migration.indexOf("$function$;", start);
  expect(end, `${name} must have a bounded body`).toBeGreaterThan(start);
  return migration.slice(start, end);
}

describe("0068 quarantined mail redaction authority v2", () => {
  it("is the contiguous successor to final 0067 replay authority", () => {
    expect(existsSync(migrationPath)).toBe(true);
    expect(migration).toContain("classify_email_outbox_quarantine_redaction_v2");
    expect(migration).toContain("redact_quarantined_email_outbox_authority_v2");
    expect(migration).toContain("email_outbox_idempotency_authority");
    expect(migration).toContain("email_outbox_idempotency_coverage_authority");
    expect(migration).toContain("idempotency_original_payload_sha256");
    expect(migration).toContain("delivery_hold_version");
    expect(migration).not.toContain("idempotency_payload_sha256");
    expect(migration).toContain(
      "lock table only public.email_outbox in access exclusive mode nowait;--> statement-breakpoint\n" +
        "set local search_path = pg_catalog, pg_temp;--> statement-breakpoint",
    );
    expect(migration).toContain("routine_oid pg_catalog.oid");
    expect(migration).toContain("acl_entry pg_catalog.record");
  });

  it("fails closed unless the load-bearing final 0067 catalog is intact", () => {
    const start = migration.indexOf("do $preflight$");
    const end = migration.indexOf("$preflight$;", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const preflight = migration.slice(start, end);

    expect(preflight).toMatch(
      /pg_catalog\.pg_get_userbyid\(relation\.relowner\)[\s\S]+?'learncoding_owner'/u,
    );
    expect(preflight).toContain("public.email_outbox_idempotency_authority");
    for (const constraint of [
      "email_outbox_delivery_scope_valid",
      "email_outbox_delivery_hold_valid",
      "email_outbox_idempotency_authority_digest_valid",
      "email_outbox_idempotency_authority_payload_valid",
      "email_outbox_idempotency_authority_payload_unique",
      "email_outbox_idempotency_authority_fk",
    ]) {
      expect(preflight).toContain(`'${constraint}'`);
    }
    expect(preflight).toContain("constraint_row.convalidated");
    expect(preflight).toContain("not constraint_row.connoinherit");
    expect(preflight).toContain(
      "c904768e4ecc145fc108de90adf0d0b5373f3330fb706ec34ff4b07d2711b94f",
    );
    expect(preflight).toContain("foreign_key.convalidated");
    expect(preflight).toContain("foreign_key.condeferrable");
    expect(preflight).toContain("foreign_key.condeferred");
    expect(preflight).toContain("foreign_key.confupdtype = 'r'");
    expect(preflight).toContain("foreign_key.confdeltype = 'r'");
    expect(preflight).toContain("foreign_key.confmatchtype = 's'");
    expect(preflight).toContain("trigger_row.tgenabled = 'a'");
    expect(preflight).toContain("trigger_row.tgtype = 19");
    expect(preflight).toContain("public.enforce_email_outbox_delivery_hold()");
    expect(preflight).toContain("routine.prosecdef");
    expect(preflight).toContain(
      "array['search_path=pg_catalog, pg_temp']::pg_catalog.text[]",
    );
    const holdRoutineStart = preflight.indexOf(
      "where routine.oid = pg_catalog.to_regprocedure(\n" +
        "             'public.enforce_email_outbox_delivery_hold()'",
    );
    const holdRoutineEnd = preflight.indexOf(
      "from pg_catalog.pg_trigger as trigger_row",
      holdRoutineStart,
    );
    expect(holdRoutineStart).toBeGreaterThanOrEqual(0);
    expect(holdRoutineEnd).toBeGreaterThan(holdRoutineStart);
    const holdRoutine = preflight.slice(holdRoutineStart, holdRoutineEnd);
    expect(holdRoutine).toContain("routine.prosrc");
    expect(holdRoutine).toContain("pg_catalog.pg_get_functiondef(routine.oid)");
    expect(holdRoutine).toContain(
      "bf644f8a69cea40011d7268ac8f14d8775045fe923cb2ca5f06a9cd25a39c8e8",
    );
    expect(holdRoutine).toContain(
      "9af2d218cd9a189c84db693acefefa10826d796058505cce85124d6830d6fe53",
    );
    expect(preflight).toContain("trigger_row.tgqual is null");
    const coverageRoutineStart = preflight.indexOf(
      "where routine.oid = pg_catalog.to_regprocedure(\n" +
        "             'public.email_outbox_idempotency_coverage_authority(pg_catalog.uuid[])'",
    );
    const coverageRoutineEnd = preflight.indexOf(
      "select coalesce(",
      coverageRoutineStart,
    );
    expect(coverageRoutineStart).toBeGreaterThan(holdRoutineEnd);
    expect(coverageRoutineEnd).toBeGreaterThan(coverageRoutineStart);
    const coverageRoutine = preflight.slice(
      coverageRoutineStart,
      coverageRoutineEnd,
    );
    expect(coverageRoutine).toContain("routine.prosrc");
    expect(coverageRoutine).toContain(
      "pg_catalog.pg_get_functiondef(routine.oid)",
    );
    expect(coverageRoutine).toContain(
      "417c8583bb2509354b89e63317718a14cd0afbf08e62d534cd64341acc290e48",
    );
    expect(coverageRoutine).toContain(
      "2efbc33e8ee9dd33402f11682697f4e522cd9e7e3c70c8bf820f533b37aec1ac",
    );
    expect(preflight).not.toContain(
      "7957a8c6e5b5e1a87ef22f59b02cda7600c2f902ef2b78700600387ee33e8509",
    );
    expect(preflight).not.toContain(
      "6e7e07cb84083bef2bdf2dcf58578b7fb4e224494fe1a70ba33284bd76358da8",
    );
    expect(preflight).toContain(
      "public.email_outbox_idempotency_coverage_authority(pg_catalog.uuid[])",
    );
    expect(preflight).toContain("pg_catalog.aclexplode");
    expect(preflight).toContain(
      "'learncoding_ops|learncoding_owner|execute|false'",
    );
    expect(preflight).toContain(
      "'learncoding_owner|learncoding_owner|execute|false'",
    );
  });

  it("uses one classifier for age, lock selection, CAS, and trigger authorization", () => {
    const classifier =
      '"public"."classify_email_outbox_quarantine_redaction_v2"';
    expect(migration.split(classifier).length - 1).toBeGreaterThanOrEqual(5);
    expect(migration).toMatch(
      /coalesce\(\s*candidate\.quarantined_at,\s*candidate\.updated_at,\s*candidate\.created_at\s*\)\s*<\s*cutoff_at/u,
    );
    expect(migration).toContain("for update of candidate skip locked");
    expect(migration).toContain("as raw_disposition");
    expect(migration).toContain("redaction_disposition :=");
    expect(migration).toMatch(
      /where outbox\.id = eligible_rows\.id[\s\S]+classify_email_outbox_quarantine_redaction_v2/u,
    );
  });

  it("blocks only a complete live claim and redacts absent, partial, or expired claims", () => {
    const classifier = functionBody(
      "classify_email_outbox_quarantine_redaction_v2",
    );
    expect(classifier).toContain(
      "claim_authority_parts := pg_catalog.num_nonnulls(",
    );
    expect(classifier).toContain("if claim_authority_parts = 0 then");
    expect(classifier).toContain("if claim_authority_parts between 1 and 2 then");
    expect(classifier).toMatch(
      /claim_authority_parts = 3[\s\S]+lease_expires_at\s*>\s*pg_catalog\.statement_timestamp\(\)[\s\S]+return 'blocked'/u,
    );
    expect(classifier).not.toContain("adapter = 'gmail'");
    expect(classifier).not.toContain("provider_message_id is null");
  });

  it("locks and redacts raw malformed rows with classifier-consistent variables", () => {
    const trigger = functionBody("enforce_email_outbox_payload_immutable");
    const redactor = functionBody(
      "redact_quarantined_email_outbox_authority_v2",
    );
    expect(trigger).toMatch(
      /redaction_disposition in \([\s\S]+?'eligible_malformed',\s*'malformed'\s*\)/u,
    );
    expect(trigger).toContain(
      "case when redaction_disposition = 'eligible_system'",
    );
    expect(redactor).toMatch(
      /where classified\.raw_disposition in \([\s\S]+?'eligible_malformed',\s*'malformed'\s*\)[\s\S]+?for update of candidate skip locked/u,
    );
    expect(redactor).toContain(
      "when eligible_rows.raw_disposition = 'eligible_system'",
    );
    expect(redactor).not.toMatch(
      /variables = case\s+when outbox\.user_id is null\s+and outbox\.delivery_scope_key/u,
    );
  });

  it("redacts deterministic PII without changing any delivery or replay authority", () => {
    for (const disposition of [
      "eligible_account",
      "eligible_system",
      "eligible_operation",
      "eligible_malformed",
      "malformed",
    ]) {
      expect(migration).toContain(`'${disposition}'`);
    }
    expect(migration).toMatch(
      /to_email\s*=\s*'redacted\+'\s*\|\|\s*outbox\.id::text\s*\|\|\s*'@invalid\.local'/u,
    );
    expect(migration).toContain("'_mailaudienceid'");

    const updateStart = migration.indexOf("update public.email_outbox as outbox");
    const updateEnd = migration.indexOf("returning outbox.id", updateStart);
    expect(updateStart).toBeGreaterThanOrEqual(0);
    expect(updateEnd).toBeGreaterThan(updateStart);
    const update = migration.slice(updateStart, updateEnd);
    for (const protectedColumn of [
      "user_id",
      "template",
      "template_version",
      "idempotency_key",
      "idempotency_authority_version",
      "idempotency_authority_sha256",
      "idempotency_original_payload_sha256",
      "delivery_hold_version",
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
      "dispatch_binding_version",
      "dispatch_binding_sha256",
      "provider_correlation_version",
      "provider_evidence_version",
      "provider_evidence_sha256",
      "provider_message_id",
      "next_attempt_at",
      "sent_at",
      "quarantined_at",
      "last_error_code",
      "created_at",
    ]) {
      expect(update).not.toMatch(new RegExp(`\\b${protectedColumn}\\s*=`, "u"));
    }
  });

  it("seals the classifier and mutator ACL while exposing only ops redaction", () => {
    expect(migration).toContain("security definer");
    expect(migration).toContain("set search_path = pg_catalog");
    expect(migration).toContain("session_user <> 'learncoding_ops'");
    expect(migration).toContain("current_user <> 'learncoding_owner'");
    expect(migration).toContain("pg_catalog.aclexplode");
    expect(migration).toContain("from %i cascade");
    expect(migration).toMatch(
      /grant execute on function\s+"?public"?\."?redact_quarantined_email_outbox_authority_v2"?[\s\S]+to learncoding_ops/u,
    );
    expect(migration).not.toMatch(
      /grant execute on function\s+"?public"?\."?classify_email_outbox_quarantine_redaction_v2"?[\s\S]+to learncoding_ops/u,
    );
  });

  it("terminates with an independent exact catalog and ACL verifier", () => {
    const finalGrant = migration.lastIndexOf("grant execute on function");
    const finalLegacyDrop = migration.lastIndexOf(
      'drop function if exists\n  "public"."classify_email_outbox_retention_redaction"',
    );
    const terminalStart = migration.indexOf(
      "do $verify_terminal_catalog$",
      finalGrant,
    );
    const terminalMarker = "$verify_terminal_catalog$;";
    const terminalEnd = migration.indexOf(terminalMarker, terminalStart);
    expect(finalGrant).toBeGreaterThanOrEqual(0);
    expect(finalLegacyDrop).toBeGreaterThan(finalGrant);
    expect(terminalStart).toBeGreaterThan(finalLegacyDrop);
    expect(terminalEnd).toBeGreaterThan(terminalStart);
    expect(migration.slice(terminalEnd + terminalMarker.length).trim()).toBe("");
    const terminal = migration.slice(terminalStart, terminalEnd);

    for (const signature of [
      "public.classify_email_outbox_quarantine_redaction_v2(public.email_outbox,timestamp with time zone)",
      "public.enforce_email_outbox_payload_immutable()",
      "public.redact_quarantined_email_outbox_authority_v2(timestamp with time zone,integer)",
    ]) {
      expect(terminal).toContain(`'${signature}'`);
    }
    expect(terminal).toContain("pg_catalog.to_regprocedure");
    expect(terminal).toContain("from pg_catalog.pg_proc as routine");
    expect(terminal).toContain("join pg_catalog.pg_language as language");
    expect(
      terminal.split(
        "pg_catalog.pg_get_userbyid(routine.proowner) = 'learncoding_owner'",
      ).length - 1,
    ).toBe(3);
    expect(terminal).toContain("routine.prosecdef");
    expect(terminal).toContain("not routine.prosecdef");
    expect(terminal).toContain("routine.provolatile = 's'");
    expect(terminal).toContain("routine.provolatile = 'v'");
    expect(terminal).toContain(
      "routine.proconfig =\n             array['search_path=pg_catalog']::pg_catalog.text[]",
    );
    expect(terminal.split("language.lanname = 'plpgsql'").length - 1).toBe(3);

    expect(terminal).toContain("pg_catalog.aclexplode");
    expect(terminal).toContain("pg_catalog.acldefault('f', routine.proowner)");
    expect(terminal).toContain("case when access.grantee = 0");
    expect(terminal).toContain("access.is_grantable::pg_catalog.text");
    expect(terminal).toContain("function_acl is distinct from array[");
    for (const aclEntry of [
      "classifier|learncoding_owner|learncoding_owner|execute|false",
      "immutable|learncoding_owner|learncoding_owner|execute|false",
      "redactor|learncoding_ops|learncoding_owner|execute|false",
      "redactor|learncoding_owner|learncoding_owner|execute|false",
    ]) {
      expect(terminal).toContain(`'${aclEntry}'`);
    }
    for (const error of [
      "0068 classifier catalog contract is invalid",
      "0068 immutable trigger routine catalog contract is invalid",
      "0068 redactor catalog contract is invalid",
      "0068 function acl contract is invalid",
      "0068 payload immutable trigger contract is invalid",
    ]) {
      expect(terminal).toContain(`raise exception '${error}'`);
    }
    expect(terminal.split("using errcode = '42501'").length - 1).toBe(5);
    expect(terminal).toContain("from pg_catalog.pg_trigger as trigger_row");
    for (const triggerCheck of [
      "not trigger_row.tgisinternal",
      "trigger_row.tgconstraint = 0",
      "trigger_row.tgconstrrelid = 0",
      "trigger_row.tgqual is null",
      "trigger_row.tgtype = 19",
      "trigger_row.tgenabled = 'a'",
      "trigger_row.tgfoid = immutable_oid",
    ]) {
      expect(terminal).toContain(triggerCheck);
    }
    expect(terminal).toContain("trigger_row.tgattr::pg_catalog.int2[]");
    for (const column of [
      "delivery_hold_version",
      "delivery_scope_key",
      "idempotency_authority_sha256",
      "idempotency_authority_version",
      "idempotency_key",
      "idempotency_original_payload_sha256",
      "operation_id",
      "template",
      "template_version",
      "to_email",
      "user_id",
      "variables",
    ]) {
      expect(terminal).toContain(`'${column}'`);
    }
  });

  it("calls v2 redaction before exact-ID, strict-coverage terminal deletion", () => {
    const redaction = retention.indexOf(
      "from public.redact_quarantined_email_outbox_authority_v2(",
    );
    const coverage = retention.indexOf(
      "public.email_outbox_idempotency_coverage_authority(",
      redaction,
    );
    const deletion = retention.indexOf(
      "delete from email_outbox where id in",
      coverage,
    );
    expect(redaction).toBeGreaterThanOrEqual(0);
    expect(coverage).toBeGreaterThan(redaction);
    expect(deletion).toBeGreaterThan(coverage);
    expect(retention.slice(deletion)).toContain("id = any($3::uuid[])");
    expect(retention).not.toContain(
      "from public.redact_unresolved_email_outbox_authority(",
    );
  });

  it("fails closed when transition summaries exceed the requested batch", () => {
    expect(retention).toContain("malformedtransitioned");
    expect(retention).toMatch(
      /eligibletransitioned\s*>\s*batchlimit/u,
    );
    expect(retention).toMatch(
      /malformedtransitioned\s*>\s*batchlimit\s*-\s*eligibletransitioned/u,
    );
  });
});
