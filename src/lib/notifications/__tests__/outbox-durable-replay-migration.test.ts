import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalizePostgresStatement,
  splitPostgresStatements,
} from "../../../../scripts/lib/postgres-sql-statements.mjs";

const repositoryRoot = process.cwd();
const migrationPath = resolve(
  repositoryRoot,
  "drizzle",
  "0067_mail_outbox_durable_replay_authority.sql",
);
const migration = existsSync(migrationPath)
  ? readFileSync(migrationPath, "utf8")
  : "";
const normalized = migration.toLowerCase().replace(/\s+/gu, " ").trim();
const redactionMigration = readFileSync(
  resolve(
    repositoryRoot,
    "drizzle",
    "0063_mail_outbox_redaction_fence_release.sql",
  ),
  "utf8",
);
const normalizedRedaction = redactionMigration
  .toLowerCase()
  .replace(/\s+/gu, " ")
  .trim();
const snapshotPath = resolve(repositoryRoot, "drizzle", "meta", "0067_snapshot.json");
const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as {
  prevId?: unknown;
  version?: unknown;
  dialect?: unknown;
  tables?: Record<string, {
    columns?: Record<string, { default?: unknown; notNull?: unknown }>;
    foreignKeys?: Record<string, {
      name?: unknown;
      columnsFrom?: unknown;
      columnsTo?: unknown;
      onDelete?: unknown;
      onUpdate?: unknown;
      tableFrom?: unknown;
      tableTo?: unknown;
    }>;
    uniqueConstraints?: Record<string, {
      name?: unknown;
      columns?: unknown;
      nullsNotDistinct?: unknown;
    }>;
    indexes?: Record<string, {
      name?: unknown;
      columns?: unknown;
      isUnique?: unknown;
      where?: unknown;
      concurrently?: unknown;
      method?: unknown;
      with?: unknown;
    }>;
    checkConstraints?: Record<string, {
      name?: unknown;
      value?: unknown;
    }>;
  }>;
};
const snapshotSha256 = createHash("sha256")
  .update(readFileSync(snapshotPath))
  .digest("hex");

const SOURCE_MAP_TEMPLATES = [
  "reset-password",
  "invitation",
  "lost-device-proof",
  "access-rejected",
  "session-revocation-requested",
  "account-deleted",
  "inactivity-reminder",
  "inactivity-reminder-followup",
  "inactivity-admin-notice",
  "daily-study-reminder",
  "revision-reminder",
  "goal-reminder",
  "challenge-reminder",
  "weekly-summary",
  "backup-status",
  "verify-email",
  "fallback-grant-changed",
  "learning-plan-changed",
  "storage-quota-changed",
  "mastery-awarded",
  "appeal-updated",
  "assessment-corrected",
] as const;

const RETAINED_TEMPLATE_VERSIONS = {
  "access-request-admin": "legacy-key-source-one-shot-v1",
  "new-device": "legacy-key-source-one-shot-v1",
  "session-revoked": "legacy-key-source-one-shot-v1",
  "learning-request-updated": "legacy-key-terminal-cas-v1",
  "session-revocation-updated": "legacy-key-terminal-cas-v1",
  "credential-changed": "legacy-key-protocol-retired-v1",
  "credential-revealed": "legacy-key-fresh-action-v1",
} as const;

function migrationBlock(start: string, end: string) {
  const startIndex = normalized.indexOf(start);
  const endIndex = normalized.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return normalized.slice(startIndex, endIndex);
}

describe("0067 durable email replay authority", () => {
  it("exists at the contiguous final migration slot", () => {
    expect(existsSync(migrationPath)).toBe(true);
  });

  it("establishes an opaque two-digest authority before writers resume", () => {
    expect(normalized).toContain(
      "lock table public.email_outbox, public.backup_status_mail_authority in access exclusive mode",
    );
    expect(normalized).toMatch(
      /add column idempotency_authority_version pg_catalog\.text,[\s\S]*add column idempotency_authority_sha256 pg_catalog\.text,[\s\S]*add column idempotency_original_payload_sha256 pg_catalog\.text/u,
    );
    expect(normalized).toMatch(
      /create table public\.email_outbox_idempotency_authority \([\s\S]*idempotency_sha256 pg_catalog\.text primary key,[\s\S]*original_payload_sha256 pg_catalog\.text not null/u,
    );
    expect(normalized).toContain(
      "alter column idempotency_original_payload_sha256 set not null",
    );
    expect(normalized).not.toMatch(/\b(?:md5|sha1|pgcrypto)\b/u);
  });

  it("uses one logical replay-conflict fingerprint and rejects ambiguous historical shapes", () => {
    const digestFunction = migrationBlock(
      "create function public.email_outbox_original_payload_sha256(",
      "create function public.email_outbox_event_sha256(",
    );

    expect(digestFunction).toContain(
      "pg_catalog.to_jsonb('mail-replay-conflict-v1'::pg_catalog.text)",
    );
    expect(digestFunction).toMatch(
      /pg_catalog\.to_jsonb\(input_template\)[\s\S]*when input_user_id is not null then 'a:' \|\| input_user_id[\s\S]*'s:' \|\| \(input_variables ->> '_mailproducer'\) \|\| ':' \|\| \(input_variables ->> '_mailsourceid'\) \|\| ':' \|\| \(input_variables ->> '_mailaudienceid'\)[\s\S]*pg_catalog\.to_jsonb\(input_to_email\)[\s\S]*pg_catalog\.to_jsonb\(input_template_version\)/u,
    );
    expect(digestFunction).toContain("pg_catalog.to_jsonb(input_to_email)");
    expect(digestFunction).not.toMatch(
      /(?:lower|btrim)\s*\(\s*input_to_email/u,
    );
    expect(digestFunction).toMatch(
      /case when pg_catalog\.jsonb_typeof\(input_variables\) = 'object' then input_variables - array\[\s*'_mailoperationid',\s*'_mailrecipient'\s*\] else input_variables end/u,
    );
    expect(digestFunction).not.toMatch(
      /input_variables - array\[[\s\S]*?'_mailproducer'/u,
    );
    expect(digestFunction).not.toMatch(
      /input_variables - array\[[\s\S]*?'_mailsourceid'/u,
    );
    expect(digestFunction).not.toMatch(
      /input_variables - array\[[\s\S]*?'_mailaudienceid'/u,
    );

    const variablesPreflight = normalized.indexOf(
      "email outbox variables must be json objects at idempotency authority cutover",
    );
    const variablesConstraint = normalized.indexOf(
      "constraint email_outbox_variables_object_valid",
    );
    expect(variablesPreflight).toBeGreaterThanOrEqual(0);
    expect(variablesConstraint).toBeGreaterThan(variablesPreflight);
    expect(normalized).toContain(
      "constraint email_outbox_variables_object_valid check ((pg_catalog.jsonb_typeof(variables) = 'object') is true) not valid",
    );
    expect(normalized).toContain(
      "constraint email_outbox_recipient_canonical_valid check (( pg_catalog.encode( pg_catalog.convert_to(to_email, 'utf8'), 'hex' ) ~ '^([0-7][0-9a-f])+$' and pg_catalog.btrim(to_email) = to_email and pg_catalog.lower(to_email collate \"c\") = to_email ) is true) not valid",
    );

    const recipientPreflight = normalized.indexOf(
      "email outbox recipient must be canonical ascii at idempotency authority cutover",
    );
    const recipientConstraint = normalized.indexOf(
      "constraint email_outbox_recipient_canonical_valid",
    );
    expect(recipientPreflight).toBeGreaterThanOrEqual(0);
    expect(recipientConstraint).toBeGreaterThan(recipientPreflight);
  });

  it("locks mutable proof sources and defers event-to-authority referential integrity", () => {
    expect(normalized).toContain(
      "lock table public.email_outbox, public.backup_status_mail_authority in access exclusive mode nowait",
    );
    expect(normalized).toContain(
      'lock table public."user", public.verification, public.lost_device_proof, public.session_revocation_request, public.inactivity_episode, public.smart_reminder_dispatch, public.access_request, public.invitation in share mode nowait',
    );
    expect(normalized).toContain(
      "constraint email_outbox_idempotency_authority_payload_unique unique (idempotency_sha256, original_payload_sha256)",
    );
    expect(normalized).toMatch(
      /constraint email_outbox_idempotency_authority_fk foreign key \( idempotency_authority_sha256, idempotency_original_payload_sha256 \) references public\.email_outbox_idempotency_authority \( idempotency_sha256, original_payload_sha256 \) on update restrict on delete restrict deferrable initially deferred not valid/u,
    );
    expect(normalized).toContain(
      "validate constraint email_outbox_idempotency_authority_fk",
    );
  });
  it("classifies every production template with an exact reviewed legacy strategy", () => {
    const policySource = readFileSync(
      resolve(
        repositoryRoot,
        "src",
        "lib",
        "notifications",
        "template-authority-policy.ts",
      ),
      "utf8",
    );
    const registry = policySource.match(
      /PRODUCTION_EMAIL_TEMPLATE_DEFINITIONS = Object\.freeze\(\[([\s\S]*?)\] as const\)/u,
    );
    expect(registry).not.toBeNull();
    const templates = [...(registry?.[1] ?? "").matchAll(/"([^"]+)"/gu)]
      .map((match) => match[1]);
    expect(templates).toHaveLength(29);
    expect(new Set([
      ...SOURCE_MAP_TEMPLATES,
      ...Object.keys(RETAINED_TEMPLATE_VERSIONS),
    ])).toEqual(
      new Set(templates),
    );

    for (const template of SOURCE_MAP_TEMPLATES) {
      expect(normalized).toMatch(
        new RegExp(
          `\\('${template}'\\s*,\\s*'event-v1-source-map'\\)`,
          "u",
        ),
      );
    }
    for (const [template, version] of Object.entries(
      RETAINED_TEMPLATE_VERSIONS,
    )) {
      expect(normalized).toMatch(
        new RegExp(`\\('${template}'\\s*,\\s*'${version}'\\)`, "u"),
      );
    }
    expect(normalized).toContain(
      "unknown email outbox template at idempotency authority cutover",
    );
  });

  it("promotes only backup-status and blocks every unauthenticated legacy source map", () => {
    const proof = migrationBlock(
      "create temp table mail_outbox_proven_legacy_source_map",
      "email outbox generated legacy alias has unreviewed strategy",
    );
    expect(proof).toContain("join public.backup_status_mail_authority");
    expect(proof).toMatch(/join public\."user"/u);
    expect(proof).toContain(
      "outbox.idempotency_key = 'backup-status:v1:' || source.run_key",
    );
    expect(proof).toContain("source.outcome || ':' || source.run_key");
    expect(proof.match(/where outbox\.template = 'backup-status'/gu))
      .toHaveLength(1);

    for (const unsafeRelation of [
      "verification",
      "lost_device_proof",
      "session_revocation_request",
      "inactivity_episode",
      "smart_reminder_dispatch",
      "access_request",
      "invitation",
      "storage_quota_change",
      "account_deletion_tombstone",
      "data_lifecycle_run",
    ]) {
      expect(proof).not.toContain(`join public.${unsafeRelation}`);
    }
    expect(normalized).toContain(
      "no durable historical app_url origin and deletion",
    );
    expect(normalized).toContain(
      "cannot recompute recipienthmacsha256 without the deletion hmac secret",
    );
    expect(normalized).toMatch(
      /update public\.email_outbox as outbox set idempotency_authority_version = policy\.authority_version from pg_temp\.mail_outbox_replay_policy as policy where policy\.template = outbox\.template and policy\.authority_version <> 'event-v1-source-map'/u,
    );
    expect(normalized).toMatch(
      /update public\.email_outbox as outbox set idempotency_authority_version = 'event-v1-source-map', idempotency_authority_sha256 = source_map\.idempotency_sha256, idempotency_original_payload_sha256 = source_map\.original_payload_sha256 from pg_temp\.mail_outbox_proven_legacy_source_map as source_map/u,
    );
  });

  it("validates before insert and persists authority only after a row is inserted", () => {
    expect(normalized).toMatch(
      /create function public\.claim_email_outbox_idempotency_authority\(\) returns pg_catalog\.trigger language plpgsql volatile security definer set search_path = pg_catalog, pg_temp/u,
    );
    expect(normalized).toContain(
      "new.idempotency_authority_version is distinct from 'event-v1-native'",
    );
    expect(normalized).toContain(
      "new.idempotency_authority_sha256 := new.idempotency_key",
    );
    expect(normalized).toContain(
      "new.idempotency_original_payload_sha256 := public.email_outbox_original_payload_sha256(",
    );
    expect(normalized).toContain(
      "email outbox idempotency event payload conflict",
    );
    expect(normalized).toMatch(
      /pg_catalog\.pg_advisory_xact_lock\(\s*pg_catalog\.hashtextextended\(new\.idempotency_authority_sha256, 0\)\s*\)/u,
    );
    const beforeFunction = normalized.slice(
      normalized.indexOf(
        "create function public.claim_email_outbox_idempotency_authority()",
      ),
      normalized.indexOf(
        "create function public.persist_email_outbox_idempotency_authority()",
      ),
    );
    const replayLookup = beforeFunction.indexOf(
      "select authority.original_payload_sha256",
    );
    const replayReturn = beforeFunction.lastIndexOf("return null");
    for (const validation of [
      "email outbox replay variables must be a json object",
      "email outbox replay recipient must be canonical ascii",
      "email outbox replay envelope key casing is invalid",
      "account email outbox replay envelope is invalid",
      "system email outbox replay envelope is invalid",
      "new.delivery_scope_key is distinct from 'a:' || new.user_id",
      "'s:' || new.operation_id::pg_catalog.text",
      "new.variables ->> '_mailoperationid' is distinct from new.operation_id::pg_catalog.text",
      "new.variables ->> '_mailrecipient' is distinct from new.to_email",
      "new.variables ->> '_mailsourceid' ~",
      "new.variables ->> '_mailaudienceid' ~",
      "new.template = 'access-request-admin'",
      "new.template = 'invitation'",
      "new.template = 'access-rejected'",
    ]) {
      const validationIndex = beforeFunction.indexOf(validation);
      expect(validationIndex).toBeGreaterThanOrEqual(0);
      expect(validationIndex).toBeLessThan(replayLookup);
      expect(validationIndex).toBeLessThan(replayReturn);
    }
    expect(beforeFunction).toContain(
      "replay-conflict evidence only; not provider-delivery authorization",
    );
    expect(beforeFunction).toMatch(
      /new\.variables \?\| reserved_envelope_keys[\s\S]*new\.variables \?& reserved_envelope_keys/u,
    );
    expect(beforeFunction).not.toContain(
      "insert into public.email_outbox_idempotency_authority",
    );
    expect(normalized).toMatch(
      /create function public\.persist_email_outbox_idempotency_authority\(\) returns pg_catalog\.trigger language plpgsql volatile security definer set search_path = pg_catalog, pg_temp/u,
    );
    expect(normalized).toMatch(
      /create trigger "00_email_outbox_idempotency_persist" after insert on public\.email_outbox/u,
    );
    expect(normalized).toContain("return null");
    expect(normalized).toContain(
      "current_setting('transaction_isolation') is distinct from 'read committed'",
    );
    expect(normalized).toContain(
      "email outbox replay authority requires read committed isolation",
    );
    expect(normalized).toContain("current_setting('lock_timeout')");
    expect(normalized).toContain("set_config('lock_timeout', '5s', true)");
    expect(normalized).toContain(
      "set_config('lock_timeout', prior_lock_timeout, true)",
    );
    expect(normalized).toMatch(
      /from public\.email_outbox as prior_outbox[\s\S]*where prior_outbox\.idempotency_authority_sha256 = new\.idempotency_authority_sha256/u,
    );
    expect(normalized).toMatch(
      /create trigger email_outbox_idempotency_claim before insert on public\.email_outbox/u,
    );
    expect(normalized).toMatch(
      /create trigger email_outbox_idempotency_metadata_immutable before update of idempotency_key, idempotency_authority_version, idempotency_authority_sha256, idempotency_original_payload_sha256 on public\.email_outbox/u,
    );
  });

  it("orders AFTER persistence before the exact immediate FK check", () => {
    const harness = readFileSync(
      resolve(
        repositoryRoot,
        "infra",
        "tests",
        "mail-durable-replay-0067.impl.mjs",
      ),
      "utf8",
    );
    expect(normalized).not.toMatch(
      /create trigger email_outbox_idempotency_persist /u,
    );
    expect(normalized).toContain(
      "reviewed_fk_trigger.tgconstraint = reviewed_foreign_key.oid",
    );
    expect(normalized).toContain("reviewed_fk_trigger.tgisinternal");
    expect(normalized).toContain("reviewed_fk_trigger.tgtype = 5");
    expect(normalized).toMatch(
      /pg_catalog\.to_regprocedure\(\s*'pg_catalog\."ri_fkey_check_ins"\(\)'\s*\)/u,
    );
    expect(normalized).toMatch(
      /pg_catalog\.convert_to\(\s*reviewed_persist_trigger\.tgname::(?:pg_catalog\.)?text,\s*'utf8'\s*\)\s*</u,
    );
    expect(harness).toContain("constraint-all-immediate-novel");
    expect(harness).toContain(
      "constraint-retroactive-immediate-novel",
    );
    expect(harness).toContain("SET CONSTRAINTS ALL IMMEDIATE");
    expect(harness).toContain(
      "mail_durable_replay_0067=immediate_fk_modes:3:pass",
    );
    expect(harness).toContain(
      "mail_durable_replay_0067=unrelated_conflict_no_orphan:pass",
    );
  });
  it("indexes the retained same-statement replay lookup exactly", () => {
    expect(normalized).toContain(
      "create index email_outbox_idempotency_authority_lookup_idx on public.email_outbox using btree (idempotency_authority_sha256, id) where idempotency_authority_sha256 is not null",
    );
    const schema = readFileSync(
      resolve(repositoryRoot, "src", "lib", "db", "schema.ts"),
      "utf8",
    );
    expect(schema).toContain(
      'index("email_outbox_idempotency_authority_lookup_idx")',
    );
    expect(
      snapshot.tables?.["public.email_outbox"]?.indexes?.[
        "email_outbox_idempotency_authority_lookup_idx"
      ],
    ).toEqual({
      name: "email_outbox_idempotency_authority_lookup_idx",
      columns: [
        {
          expression: "idempotency_authority_sha256",
          isExpression: false,
          asc: true,
          nulls: "last",
        },
        {
          expression: "id",
          isExpression: false,
          asc: true,
          nulls: "last",
        },
      ],
      isUnique: false,
      where: '"email_outbox"."idempotency_authority_sha256" IS NOT NULL',
      concurrently: false,
      method: "btree",
      with: {},
    });
  });

  it("makes coverage bounded, row-locked, redaction-stable, and ops-only", () => {
    expect(normalized).toMatch(
      /create function public\.email_outbox_idempotency_coverage_authority\(\s*candidate_ids pg_catalog\.uuid\[\]\s*\) returns pg_catalog\.boolean language plpgsql security definer set search_path = pg_catalog, pg_temp/u,
    );
    expect(normalized).toContain(
      "candidate_count := pg_catalog.cardinality(candidate_ids)",
    );
    expect(normalized).toContain("candidate_count not between 1 and 5000");
    expect(normalized).toContain("with locked_outbox as materialized (");
    expect(normalized).toContain("order by outbox.id for update of outbox");
    expect(normalized).not.toMatch(
      /perform outbox\.id[\s\S]*select pg_catalog\.count\(\*\) = candidate_count/u,
    );
    expect(normalized).toContain(
      "authority.original_payload_sha256 is not distinct from outbox.idempotency_original_payload_sha256",
    );
    expect(normalized).toMatch(
      /grant execute on function public\.email_outbox_idempotency_coverage_authority\(pg_catalog\.uuid\[\]\) to learncoding_ops/u,
    );
    expect(normalized).toContain(
      "create trigger email_outbox_idempotency_append_only",
    );
    expect(normalized).toContain(
      "create trigger email_outbox_idempotency_no_truncate",
    );
    const redactionUpdate = normalizedRedaction.slice(
      normalizedRedaction.indexOf("update public.email_outbox as outbox"),
      normalizedRedaction.indexOf("returning outbox.id"),
    );
    expect(redactionUpdate).not.toContain(
      "idempotency_original_payload_sha256",
    );
    expect(normalized).toContain(
      "new.idempotency_original_payload_sha256 is distinct from old.idempotency_original_payload_sha256",
    );
  });

  it("scrubs hostile default and delegated ACLs dynamically, then verifies the exact contract", () => {
    expect(normalized).toContain(
      "pg_catalog.aclexplode",
    );
    expect(normalized).toContain(
      "revoke all privileges on function %s from %s cascade",
    );
    expect(normalized).toContain(
      "revoke all privileges on table %s from %s cascade",
    );
    expect(normalized).toContain(
      "revoke all privileges (%i) on table %s from %s cascade",
    );
    expect(normalized).toContain(
      "email outbox idempotency function acl contract failed",
    );
    expect(normalized).toContain(
      "email outbox idempotency authority table acl contract failed",
    );
    expect(normalized).toContain(
      "email outbox idempotency column acl contract failed",
    );
  });

  it("hardens every privileged routine and authority-table column ACL", () => {
    expect(
      normalized.match(
        /security definer set search_path = pg_catalog, pg_temp/gu,
      ),
    ).toHaveLength(9);
    expect(normalized).not.toContain(
      "security definer set search_path = pg_catalog as $function$",
    );
    expect(normalized).toContain(")::pg_catalog.text");
    expect(normalized).toContain(
      "prior_lock_timeout::pg_catalog.interval",
    );
    expect(normalized).toContain(
      "pg_catalog.count(distinct candidate_id)::pg_catalog.int4",
    );
    expect(normalized).toContain("authority_column_row pg_catalog.record");
    expect(normalized).toContain("set local role %s");
    expect(normalized).toContain("reset role");
    expect(normalized).toMatch(
      /where attribute\.attrelid = 'public\.email_outbox_idempotency_authority'::pg_catalog\.regclass[\s\S]*pg_catalog\.aclexplode\(authority_column_row\.attacl\)[\s\S]*revoke all privileges \(%i\) on table %s from %s cascade/u,
    );
    expect(normalized).toContain(
      "email outbox idempotency authority table column acl contract failed",
    );
  });

  it("updates schema metadata without exposing database-owned digests to writers", () => {
    const schema = readFileSync(
      resolve(repositoryRoot, "src", "lib", "db", "schema.ts"),
      "utf8",
    );
    expect(schema).toContain(
      'idempotencyAuthorityVersion: text("idempotency_authority_version")',
    );
    expect(schema).toContain(
      'idempotencyAuthoritySha256: text("idempotency_authority_sha256")',
    );
    expect(schema).toContain(
      'idempotencyOriginalPayloadSha256: text("idempotency_original_payload_sha256")',
    );
    expect(schema).toContain(".$defaultFn(() => sql`NULL`)");
    expect(schema).not.toContain(".default(sql`NULL`)");
    expect(schema).toMatch(
      /email_outbox_idempotency_authority_valid[\s\S]*?\)\s+IS TRUE/u,
    );
    expect(schema).toContain(
      'export const emailOutboxIdempotencyAuthority = pgTable(',
    );
    expect(schema).toMatch(
      /check\(\s*"email_outbox_variables_object_valid"/u,
    );
    expect(schema).toMatch(
      /check\(\s*"email_outbox_recipient_canonical_valid"/u,
    );

    const outboxChecks =
      snapshot.tables?.["public.email_outbox"]?.checkConstraints;
    expect(outboxChecks?.email_outbox_variables_object_valid).toEqual({
      name: "email_outbox_variables_object_valid",
      value:
        "(pg_catalog.jsonb_typeof(\"email_outbox\".\"variables\") = 'object') IS TRUE",
    });
    expect(outboxChecks?.email_outbox_recipient_canonical_valid).toEqual({
      name: "email_outbox_recipient_canonical_valid",
      value:
        "(\n"
        + "        pg_catalog.encode(\n"
        + "          pg_catalog.convert_to(\"email_outbox\".\"to_email\", 'UTF8'),\n"
        + "          'hex'\n"
        + "        ) ~ '^([0-7][0-9a-f])+$'\n"
        + "        AND pg_catalog.btrim(\"email_outbox\".\"to_email\") = \"email_outbox\".\"to_email\"\n"
        + "        AND pg_catalog.lower(\"email_outbox\".\"to_email\" COLLATE \"C\") = \"email_outbox\".\"to_email\"\n"
        + "      ) IS TRUE",
    });
  });

  it("closes smart and legacy-taxonomy evidence gaps", () => {
    const harness = readFileSync(
      resolve(
        repositoryRoot,
        "infra",
        "tests",
        "mail-durable-replay-0067.impl.mjs",
      ),
      "utf8",
    );
    const goldenVector = resolve(
      repositoryRoot,
      "infra",
      "tests",
      "fixtures",
      "mail-event-v1-golden-vector.json",
    );
    const sourceMapTemplates = new Set<string>(SOURCE_MAP_TEMPLATES);
    const retainedTemplates = new Set<string>(
      Object.keys(RETAINED_TEMPLATE_VERSIONS),
    );

    expect(sourceMapTemplates.size).toBe(22);
    expect(retainedTemplates.size).toBe(7);
    expect(
      [...sourceMapTemplates].filter((template) =>
        retainedTemplates.has(template)
      ),
    ).toEqual([]);
    expect(sourceMapTemplates.size + retainedTemplates.size).toBe(29);
    expect(existsSync(goldenVector)).toBe(true);
    expect(normalized).toContain(
      "authority_version = 'event-v1-source-map') <> 22",
    );
    expect(normalized).toContain("legacy-key-blocked-v1");
    expect(normalized).toContain(
      "email outbox generated legacy alias has unreviewed strategy",
    );
    expect(harness).toContain("SMART_SOURCE_MISMATCH_USER_ID");
    expect(harness).not.toContain(
      "sourceUserId: NEAR_DELETED_USERS[0][0]",
    );
    expect(harness).toContain("legacy-weekly");
    expect(harness).toContain("current-weekly");
    expect(harness).toContain("mail-event-v1-golden-vector.json");
    expect(harness).toContain("primarySourceMapNearMisses");
    expect(harness).toContain("additionalSourceMapNearMisses");
    expect(harness).toContain("expected_authority");
    expect(harness).toContain("actual_authority");
    expect(harness).toMatch(/except all/iu);
    expect(harness).toContain("inactivity-v2-direct-conflict");
    expect(harness).toContain(
      "email outbox idempotency event payload conflict",
    );
  });
  it("makes the cutover lock topology deterministic and controller-gated", () => {
    const statements = splitPostgresStatements(migration).map(
      ({ sql: statement }) => canonicalizePostgresStatement(statement),
    );
    const expectedLocks = [
      "lock table public.email_outbox, public.backup_status_mail_authority in access exclusive mode nowait;",
      'lock table public."user", public.verification, public.lost_device_proof, public.session_revocation_request, public.inactivity_episode, public.smart_reminder_dispatch, public.access_request, public.invitation in share mode nowait;',
    ];

    expect(statements.slice(0, 2)).toEqual(expectedLocks);
    expect(
      statements.filter((statement) => statement.startsWith("lock table ")),
    ).toEqual(expectedLocks);

    const harness = readFileSync(
      resolve(
        repositoryRoot,
        "infra",
        "tests",
        "mail-durable-replay-0067.impl.mjs",
      ),
      "utf8",
    );
    expect(harness).toContain("splitPostgresStatements");
    expect(harness).toContain("canonicalizePostgresStatement");
    expect(harness).toContain("assertCutoverLockPreamble();");
    expect(harness).toContain("CUTOVER_PROOF_SOURCES");
    expect(harness).toContain("proveGrantedCutoverLocks");
    expect(harness).toContain("ROW EXCLUSIVE MODE NOWAIT");
    expect(harness).toContain("ACCESS EXCLUSIVE MODE NOWAIT");
    expect(harness).toContain("cutover migration unexpectedly reported 40P01");
    expect(harness).not.toContain("performance.now() - startedAt < 1_000");
  });

  it("uses the production trusted catalog normalization for CHECK evidence", () => {
    const harness = readFileSync(
      resolve(
        repositoryRoot,
        "infra",
        "tests",
        "mail-durable-replay-0067.impl.mjs",
      ),
      "utf8",
    );
    const start = harness.indexOf(
      "function reportReplayAuthorityConstraintCatalog",
    );
    const end = harness.indexOf(
      "async function proveBootstrapReconciliation",
      start,
    );
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const catalogReporter = harness.slice(start, end);
    expect(catalogReporter).toContain(
      "SET search_path = pg_catalog, pg_temp;",
    );
    expect(catalogReporter).toContain("pg_catalog.pg_get_expr(");
    expect(catalogReporter.match(/pg_catalog[.]regexp_replace[(]/gu)).toHaveLength(
      2,
    );
    expect(catalogReporter).toContain(
      `'"?' || relation.relname || '"?[.]'`,
    );
    expect(catalogReporter).toContain(`'[[:space:]"]'`);
    expect(catalogReporter).toContain("pg_catalog.convert_to(");
    expect(catalogReporter).toContain("pg_catalog.sha256(");
    expect(catalogReporter).toContain(
      ") AS normalized_expression_sha256",
    );
    expect(catalogReporter).not.toContain(
      "canonicalizePostgresStatement(reviewed.expression)",
    );
  });
  it("uses the production framework for unknown-template rollback evidence", () => {
    const harness = readFileSync(
      resolve(
        repositoryRoot,
        "infra",
        "tests",
        "mail-durable-replay-0067.impl.mjs",
      ),
      "utf8",
    );
    const start = harness.indexOf(
      "async function proveUnknownTemplateCutoverRollback",
    );
    const end = harness.indexOf(
      "async function releaseControllerGate",
      start,
    );
    const rollbackProof = harness.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(rollbackProof).toContain("mail0067_unknown_template_rollback");
    expect(rollbackProof).toContain("runProductionMigration");
    expect(rollbackProof).toContain("ledgerBytesBefore");
    expect(rollbackProof).toContain("ledgerTailBefore");
    expect(rollbackProof).toContain(
      "assert.ok(migrationError instanceof Error)",
    );
    expect(rollbackProof).toContain(
      "const postgresError = migrationError.cause",
    );
    expect(rollbackProof).toContain('postgresError?.code, "23514"');
    expect(rollbackProof).toContain(
      "unknown email outbox template at idempotency authority cutover",
    );
    expect(rollbackProof).toContain(
      "email_outbox_original_payload_sha256(text,text,text,text,jsonb)",
    );
    expect(rollbackProof).toContain(
      "email_outbox_event_sha256(text,text,text)",
    );
    expect(rollbackProof).toContain("dropDisposableDatabase");
    expect(rollbackProof).not.toContain("migration0067WithHostileAcls()");
  });
  it("bounds coverage locks and controls late-candidate evidence", () => {
    const coverageBlock = migrationBlock(
      "create function public.email_outbox_idempotency_coverage_authority(",
      "alter function public.claim_email_outbox_idempotency_authority()",
    );
    expect(coverageBlock).toContain("prior_lock_timeout pg_catalog.text");
    expect(coverageBlock).toContain(
      "lock_timeout_was_clamped pg_catalog.bool := false",
    );
    expect(coverageBlock).toContain(
      "prior_lock_timeout := pg_catalog.current_setting('lock_timeout')",
    );
    expect(coverageBlock).toContain(
      "set_config('lock_timeout', '5s', true)",
    );
    expect(coverageBlock).toContain(
      "set_config('lock_timeout', prior_lock_timeout, true)",
    );
    expect(coverageBlock).toContain(
      "prior_lock_timeout = '0' or extract(epoch from prior_lock_timeout::pg_catalog.interval) > 5",
    );
    expect(
      coverageBlock.match(
        /set_config\('lock_timeout', prior_lock_timeout, true\)/gu,
      ),
    ).toHaveLength(2);    expect(coverageBlock).toMatch(
      /begin with locked_outbox[\s\S]*exception when others then[\s\S]*raise/u,
    );

    const harness = readFileSync(
      resolve(
        repositoryRoot,
        "infra",
        "tests",
        "mail-durable-replay-0067.impl.mjs",
      ),
      "utf8",
    );
    const start = harness.indexOf(
      "async function proveCoverageLockAndTerminalReplay",
    );
    const end = harness.indexOf(
      "function proveFailClosedAndMutationProtection",
      start,
    );
    const coverageProof = harness.slice(start, end);
    const lateCommit = coverageProof.indexOf("snapshotLateCommitted");
    const controllerRelease = coverageProof.indexOf(
      "releaseControllerGate",
      lateCommit,
    );

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(coverageProof).toContain("coverageSnapshotController");
    expect(coverageProof).toContain("finally");
    expect(coverageProof).not.toContain("pg_sleep(3)");
    expect(lateCommit).toBeGreaterThanOrEqual(0);
    expect(controllerRelease).toBeGreaterThan(lateCommit);
    expect(coverageProof).toContain("generate_series(1, 4999)");
    expect(coverageProof).toContain("uncoveredFinalSentinel");
    expect(coverageProof).toContain(
      'message: "invalid email outbox idempotency coverage request"',
    );
  });
  it("pins a default-free 0067 snapshot to the 0066 parent", () => {
    expect(snapshot.prevId).toBe("84db88ad-ee86-4709-a5e3-be0af9b4d979");
    expect(snapshot.version).toBe("7");
    expect(snapshot.dialect).toBe("postgresql");
    const outbox = snapshot.tables?.["public.email_outbox"];
    const authority =
      snapshot.tables?.["public.email_outbox_idempotency_authority"];
    const column = outbox?.columns?.[
      "idempotency_original_payload_sha256"
    ];
    expect(column?.notNull).toBe(true);
    expect(column).not.toHaveProperty("default");
    expect(Object.keys(outbox?.foreignKeys ?? {}).sort()).toEqual([
      "email_outbox_idempotency_authority_fk",
      "email_outbox_user_id_user_id_fk",
    ]);
    expect(
      outbox?.foreignKeys?.["email_outbox_idempotency_authority_fk"],
    ).toEqual({
      name: "email_outbox_idempotency_authority_fk",
      tableFrom: "email_outbox",
      tableTo: "email_outbox_idempotency_authority",
      columnsFrom: [
        "idempotency_authority_sha256",
        "idempotency_original_payload_sha256",
      ],
      columnsTo: ["idempotency_sha256", "original_payload_sha256"],
      onDelete: "restrict",
      onUpdate: "restrict",
    });
    expect(Object.keys(authority?.uniqueConstraints ?? {})).toEqual([
      "email_outbox_idempotency_authority_payload_unique",
    ]);
    expect(
      authority?.uniqueConstraints?.[
        "email_outbox_idempotency_authority_payload_unique"
      ],
    ).toEqual({
      name: "email_outbox_idempotency_authority_payload_unique",
      columns: ["idempotency_sha256", "original_payload_sha256"],
      nullsNotDistinct: false,
    });
    expect(snapshotSha256).toBe(
      "6add0512f5d85371b99c96d43b48b28c8821e07e0940cc6fddb102fe40680160",
    );
  });
});
