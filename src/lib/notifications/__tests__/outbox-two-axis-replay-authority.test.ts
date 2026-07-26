import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const source = (path: string) =>
  readFileSync(resolve(repositoryRoot, path), "utf8");
const migration = source(
  "drizzle/0067_mail_outbox_durable_replay_authority.sql",
);
const normalized = migration.toLowerCase().replace(/\s+/gu, " ").trim();

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

const EXACT_IDENTITY_VERSIONS = [
  "event-v1-native",
  "event-v1-source-map",
  "legacy-key-source-one-shot-v1",
  "legacy-key-terminal-cas-v1",
  "legacy-key-protocol-retired-v1",
  "legacy-key-fresh-action-v1",
  "legacy-key-blocked-v1",
] as const;

const HOLD_TRIGGER_COLUMNS = [
  "adapter",
  "attempt_count",
  "claim_owner",
  "claim_token",
  "claim_version",
  "delivery_hold_version",
  "dispatch_binding_sha256",
  "dispatch_binding_version",
  "idempotency_authority_sha256",
  "idempotency_authority_version",
  "idempotency_original_payload_sha256",
  "last_error_code",
  "lease_expires_at",
  "next_attempt_at",
  "provider_call_started",
  "provider_correlation_version",
  "provider_evidence_sha256",
  "provider_evidence_version",
  "provider_message_id",
  "quarantined_at",
  "sent_at",
  "status",
] as const;

function migrationBlock(start: string, end: string) {
  const startIndex = normalized.indexOf(start);
  const endIndex = normalized.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return normalized.slice(startIndex, endIndex);
}

describe("0067 two-axis replay identity and permanent delivery hold", () => {
  it("classifies exactly 22 source-mapped and seven retained templates", () => {
    const policy = migrationBlock(
      "insert into pg_temp.mail_outbox_replay_policy",
      "unknown email outbox template at idempotency authority cutover",
    );
    const actual = Object.fromEntries(
      [...policy.matchAll(/\('([^']+)', '([^']+)'\)/gu)].map((match) => [
        match[1],
        match[2],
      ]),
    );
    const expected = Object.fromEntries([
      ...SOURCE_MAP_TEMPLATES.map((template) => [
        template,
        "event-v1-source-map",
      ]),
      ...Object.entries(RETAINED_TEMPLATE_VERSIONS),
    ]);

    expect(actual).toEqual(expected);
    expect(Object.keys(actual)).toHaveLength(29);
    expect(SOURCE_MAP_TEMPLATES).toHaveLength(22);
    expect(Object.keys(RETAINED_TEMPLATE_VERSIONS)).toHaveLength(7);
    expect(policy).toContain(
      "where authority_version = 'event-v1-source-map') <> 22",
    );
    expect(policy).toContain(
      "where authority_version = 'legacy-key-source-one-shot-v1') <> 3",
    );
    expect(policy).toContain(
      "where authority_version = 'legacy-key-terminal-cas-v1') <> 2",
    );
    expect(policy).toContain(
      "where authority_version = 'legacy-key-protocol-retired-v1') <> 1",
    );
    expect(policy).toContain(
      "where authority_version = 'legacy-key-fresh-action-v1') <> 1",
    );
  });

  it("allows exactly seven replay identities and reserves row SHA for event identities", () => {
    const constraint = migrationBlock(
      "constraint email_outbox_idempotency_authority_valid",
      "validate constraint email_outbox_idempotency_authority_valid",
    );
    for (const version of EXACT_IDENTITY_VERSIONS) {
      expect(constraint).toContain(`'${version}'`);
    }
    expect(constraint).not.toMatch(
      /'(?:event-v1|event-v1-alias|legacy-recipient-v1)'/u,
    );
    expect(constraint).toMatch(
      /idempotency_authority_version in \( 'event-v1-native', 'event-v1-source-map' \)[\s\S]*idempotency_authority_sha256 ~ '\^\[0-9a-f\]\{64\}\$'/u,
    );
    expect(constraint).toMatch(
      /idempotency_authority_version in \( 'legacy-key-source-one-shot-v1', 'legacy-key-terminal-cas-v1', 'legacy-key-protocol-retired-v1', 'legacy-key-fresh-action-v1', 'legacy-key-blocked-v1' \)[\s\S]*idempotency_authority_sha256 is null/u,
    );
  });

  it("uses blocked only as a row fallback and promotes only exact source joins", () => {
    const blocked = normalized.indexOf(
      "set idempotency_authority_version = 'legacy-key-blocked-v1'",
    );
    const retained = normalized.indexOf(
      "set idempotency_authority_version = policy.authority_version",
    );
    const sourceMapped = normalized.indexOf(
      "set idempotency_authority_version = 'event-v1-source-map'",
    );

    expect(blocked).toBeGreaterThanOrEqual(0);
    expect(retained).toBeGreaterThan(blocked);
    expect(sourceMapped).toBeGreaterThan(retained);
    expect(normalized).toContain(
      "and policy.authority_version <> 'event-v1-source-map'",
    );
    expect(normalized).toContain(
      "where policy.authority_version is distinct from 'event-v1-source-map'",
    );
    expect(normalized).not.toMatch(
      /\('(?:[^']+)', 'legacy-key-blocked-v1'\)/u,
    );
  });

  it("pins a permanent database-owned Task 7 hold on every old and new row", () => {
    const schema = source("src/lib/db/schema.ts");
    const store = source("src/lib/notifications/postgres-outbox-store.ts")
      .toLowerCase()
      .replace(/\s+/gu, " ");
    const backfill = normalized.indexOf(
      "update public.email_outbox set delivery_hold_version = 'task7-v1'",
    );
    const classification = normalized.indexOf(
      "set idempotency_authority_version = 'legacy-key-blocked-v1'",
    );

    expect(normalized).toContain("add column delivery_hold_version pg_catalog.text");
    expect(backfill).toBeGreaterThanOrEqual(0);
    expect(backfill).toBeLessThan(classification);
    expect(normalized).toContain(
      "alter column delivery_hold_version set not null",
    );
    expect(normalized).toContain(
      "constraint email_outbox_delivery_hold_valid check ((delivery_hold_version = 'task7-v1') is true)",
    );
    expect(schema).toMatch(
      /deliveryHoldVersion:\s*text\("delivery_hold_version"\)[\s\S]{0,100}\.\$defaultFn\(\(\) => sql`NULL`\)[\s\S]{0,40}\.notNull\(\)/u,
    );
    expect(normalized).toContain(
      "new.delivery_hold_version := 'task7-v1'",
    );
    expect(normalized).not.toMatch(
      /set\s+delivery_hold_version\s*=\s*null/u,
    );
    expect(normalized).not.toContain("delivery_release_receipt");
    expect(
      store.match(/delivery_hold_version is null/gu)?.length ?? 0,
    ).toBeGreaterThanOrEqual(8);
  });

  it("rejects caller-supplied delivery state before assigning the hold", () => {
    const claimGuard = migrationBlock(
      "create function public.claim_email_outbox_idempotency_authority()",
      "create function public.persist_email_outbox_idempotency_authority()",
    );
    const pristineGuard = claimGuard.indexOf(
      "if new.status is distinct from 'pending'",
    );
    const holdAssignment = claimGuard.indexOf(
      "new.delivery_hold_version := 'task7-v1'",
    );
    const forbiddenFields = [
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
      "sent_at",
      "quarantined_at",
      "last_error_code",
    ] as const;

    expect(pristineGuard).toBeGreaterThanOrEqual(0);
    expect(pristineGuard).toBeLessThan(holdAssignment);
    for (const field of forbiddenFields) {
      expect(claimGuard).toContain(`new.${field}`);
    }
    expect(claimGuard).not.toMatch(
      /new\.next_attempt_at\s+is\s+(?:not\s+)?null/u,
    );
    expect(claimGuard).toContain(
      "raise exception 'email outbox delivery state must be pristine while held' using errcode = '23514', constraint = 'email_outbox_delivery_hold_valid'",
    );
  });

  it("keeps the accepted UPDATE-only 22-column hold guard intact", () => {
    const trigger = migrationBlock(
      "create trigger email_outbox_delivery_hold",
      "create trigger email_outbox_idempotency_claim",
    );
    const triggerColumns = trigger
      .match(/before update of (.+?) on public\.email_outbox/u)?.[1]
      ?.split(",")
      .map((column) => column.trim())
      .sort();

    expect(trigger).not.toContain("before update or delete");
    expect(trigger).not.toContain("to_email");
    expect(trigger).not.toContain("variables");
    expect(trigger).not.toContain("updated_at");
    expect(triggerColumns).toEqual([...HOLD_TRIGGER_COLUMNS].sort());
    expect(normalized).toContain(
      "alter table public.email_outbox enable always trigger email_outbox_delivery_hold",
    );
  });

  it("proves retained-key coverage without using row identity as delivery permission", () => {
    const coverage = migrationBlock(
      "create function public.email_outbox_idempotency_coverage_authority(",
      "alter function public.enforce_email_outbox_delivery_hold()",
    );
    const store = source("src/lib/notifications/postgres-outbox-store.ts");
    const audiencePredicate = store.match(
      /function systemAudienceAuthorityPredicate[\s\S]*?\n\}/u,
    )?.[0] ?? "";

    expect(coverage).toContain(
      "when outbox.idempotency_authority_version in ( 'event-v1-native', 'event-v1-source-map' ) then outbox.idempotency_authority_sha256",
    );
    expect(coverage).toContain(
      "pg_catalog.sha256( pg_catalog.convert_to(outbox.idempotency_key, 'utf8') )",
    );
    expect(coverage).toContain(
      "authority.original_payload_sha256 is not distinct from outbox.idempotency_original_payload_sha256",
    );
    expect(audiencePredicate).not.toContain("idempotency_authority_version");
    expect(audiencePredicate).not.toContain("idempotency_authority_sha256");
  });
});
