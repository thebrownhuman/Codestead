import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../..");
const componentPath = path.join(
  repositoryRoot,
  "infra",
  "sql",
  "mail-outbox-durable-idempotency-authority.component.sql",
);

function normalizedSql() {
  assert.ok(
    existsSync(componentPath),
    "durable idempotency authority SQL component must exist",
  );
  return readFileSync(componentPath, "utf8")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function section(sql, start, end) {
  const startIndex = sql.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  const endIndex = sql.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return sql.slice(startIndex, endIndex);
}

test("the component establishes an opaque two-digest authority before writers resume", () => {
  const sql = normalizedSql();
  const ledgerDefinition = section(
    sql,
    "create table public.email_outbox_idempotency_authority",
    "alter table public.email_outbox_idempotency_authority",
  );

  assert.match(sql, /lock table public\.email_outbox in access exclusive mode/u);
  assert.match(
    sql,
    /add column idempotency_authority_version text, add column idempotency_authority_sha256 text, add column idempotency_original_payload_sha256 text/u,
  );
  assert.match(
    ledgerDefinition,
    /idempotency_sha256 text primary key, original_payload_sha256 text not null/u,
  );
  assert.match(
    ledgerDefinition,
    /check \(idempotency_sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/u,
  );
  assert.match(
    ledgerDefinition,
    /check \(original_payload_sha256 ~ '\^\[0-9a-f\]\{64\}\$'\)/u,
  );
  assert.doesNotMatch(
    ledgerDefinition,
    /\b(?:user_id|to_email|recipient|variables|idempotency_key)\b/u,
  );

  const exactBackfill = sql.indexOf(
    "insert into public.email_outbox_idempotency_authority",
  );
  const claimTrigger = sql.indexOf(
    "create trigger email_outbox_idempotency_claim",
  );
  assert.ok(exactBackfill >= 0, "existing keys must be digested into the ledger");
  assert.ok(
    claimTrigger > exactBackfill,
    "all existing authorities must be established before new writers resume",
  );
  assert.match(
    sql.slice(exactBackfill, claimTrigger),
    /pg_catalog\.sha256\(\s*pg_catalog\.convert_to\(outbox\.idempotency_key, 'utf8'\)\s*\)/u,
  );
  assert.match(
    sql,
    /alter column idempotency_original_payload_sha256 set not null/u,
  );
  assert.doesNotMatch(sql, /\b(?:md5|sha1|pgcrypto)\b/u);
});

test("legacy aliases require exact source evidence and unmatched legacy stays uncovered", () => {
  const sql = normalizedSql();

  assert.match(sql, /idempotency_authority_version = 'legacy-recipient-v1'/u);
  assert.match(sql, /idempotency_authority_version = 'event-v1-alias'/u);
  for (const sourceField of [
    "_mailsourceid",
    "_mailproducer",
    "resetverificationid",
    "recoveryrequestid",
    "revocationrequestid",
    "inactivityepisodeid",
    "smartreminderdispatchid",
    "deletionrunid",
  ]) {
    assert.match(sql, new RegExp(`variables ->> '${sourceField}'`, "u"));
  }
  assert.match(sql, /':requester:' \|\| candidate\.source_id/u);
  assert.match(
    sql,
    /outbox\.idempotency_key = pg_catalog\.encode\( pg_catalog\.sha256\( pg_catalog\.convert_to\(/u,
  );
  assert.match(
    sql,
    /outbox\.idempotency_authority_version in \('event-v1', 'event-v1-alias'\)/u,
  );
});

test("the trigger owns both digests, suppresses identical replay, and rejects divergence", () => {
  const sql = normalizedSql();
  const claim = section(
    sql,
    "create function public.claim_email_outbox_idempotency_authority()",
    "create function public.enforce_email_outbox_idempotency_metadata_immutable()",
  );

  assert.match(
    claim,
    /returns trigger language plpgsql security definer set search_path = pg_catalog/u,
  );
  assert.match(
    claim,
    /new\.idempotency_authority_version is distinct from 'event-v1'/u,
  );
  assert.match(claim, /new\.idempotency_authority_sha256 is not null/u);
  assert.match(claim, /new\.idempotency_original_payload_sha256 is not null/u);
  assert.match(
    claim,
    /new\.idempotency_authority_sha256 := new\.idempotency_key/u,
  );
  assert.match(
    claim,
    /new\.idempotency_original_payload_sha256 := public\.email_outbox_original_payload_sha256\(/u,
  );
  assert.match(
    claim,
    /insert into public\.email_outbox_idempotency_authority \( idempotency_sha256, original_payload_sha256 \) values \( new\.idempotency_authority_sha256, new\.idempotency_original_payload_sha256 \) on conflict \(idempotency_sha256\) do nothing returning true into claimed/u,
  );
  assert.match(claim, /if claimed is true then return new/u);
  assert.match(
    claim,
    /if prior_original_payload_sha256 is distinct from new\.idempotency_original_payload_sha256 then raise exception 'email outbox idempotency event payload conflict'/u,
  );
  assert.match(claim, /return null/u);
  assert.match(
    sql,
    /create trigger email_outbox_idempotency_claim before insert on public\.email_outbox/u,
  );
  assert.match(
    sql,
    /create trigger email_outbox_idempotency_metadata_immutable before update of idempotency_key, idempotency_authority_version, idempotency_authority_sha256, idempotency_original_payload_sha256 on public\.email_outbox/u,
  );
});

test("coverage is bounded, sorted, redaction-stable, and exposed only to ops", () => {
  const sql = normalizedSql();
  const coverage = section(
    sql,
    "create function public.email_outbox_idempotency_coverage_authority(",
    "alter function public.claim_email_outbox_idempotency_authority()",
  );

  assert.match(
    coverage,
    /candidate_ids uuid\[\] \) returns boolean language plpgsql security definer set search_path = pg_catalog/u,
  );
  assert.match(
    coverage,
    /candidate_count := pg_catalog\.cardinality\(candidate_ids\)/u,
  );
  assert.match(coverage, /candidate_count not between 1 and 5000/u);
  assert.match(coverage, /pg_catalog\.count\(distinct candidate_id\)/u);
  assert.match(coverage, /order by outbox\.id for update of outbox/u);
  assert.match(
    coverage,
    /authority\.original_payload_sha256 is not distinct from outbox\.idempotency_original_payload_sha256/u,
  );
  assert.doesNotMatch(
    coverage,
    /email_outbox_original_payload_sha256\(/u,
  );

  assert.match(
    sql,
    /grant execute on function public\.email_outbox_idempotency_coverage_authority\(uuid\[\]\) to learncoding_ops/u,
  );
  assert.match(
    sql,
    /revoke all privileges on table public\.email_outbox_idempotency_authority from public, learncoding_app, learncoding_worker, learncoding_migrator, learncoding_ops, learncoding_owner cascade/u,
  );
  assert.match(sql, /pg_catalog\.aclexplode/u);
  assert.match(
    sql,
    /revoke all \( idempotency_authority_version, idempotency_authority_sha256, idempotency_original_payload_sha256 \) on table public\.email_outbox/u,
  );
  assert.match(
    sql,
    /grant insert \(idempotency_authority_version\) on table public\.email_outbox to learncoding_worker/u,
  );
  assert.match(sql, /from %i cascade/u);
  assert.match(sql, /create trigger email_outbox_idempotency_append_only/u);
  assert.match(sql, /create trigger email_outbox_idempotency_no_truncate/u);
});

test("the migration classifies every production template and proves aliases from authoritative sources", () => {
  const sql = normalizedSql();
  const templatePolicySource = readFileSync(
    path.join(
      repositoryRoot,
      "src",
      "lib",
      "notifications",
      "template-authority-policy.ts",
    ),
    "utf8",
  );
  const registry = templatePolicySource.match(
    /PRODUCTION_EMAIL_TEMPLATE_DEFINITIONS = Object\.freeze\(\[([\s\S]*?)\] as const\)/u,
  );
  assert.ok(registry, "production mail template registry must be readable");
  const templates = [...registry[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
  assert.equal(templates.length, 29, "all current production templates are inventoried");
  for (const template of templates) {
    assert.match(
      sql,
      new RegExp(`\\('${template}'\\s*,\\s*'(?:alias-proven|retain-unmatched)'\\)`, "u"),
      `migration policy must classify ${template}`,
    );
  }
  assert.match(sql, /unknown email outbox template at idempotency authority cutover/u);
  for (const relation of [
    "verification",
    "lost_device_proof",
    "session_revocation_request",
    "inactivity_episode",
    "smart_reminder_dispatch",
    "data_lifecycle_run",
    "account_deletion_tombstone",
    "access_request",
    "invitation",
  ]) {
    assert.match(sql, new RegExp(`join public\\.${relation}`, "u"));
  }
  assert.match(sql, /join public\."user"/u);
  assert.match(sql, /_mailaudienceid/u);
});

test("the component stays unnumbered until composition assigns the contiguous slot", () => {
  assert.equal(
    path.basename(componentPath),
    "mail-outbox-durable-idempotency-authority.component.sql",
  );
});
