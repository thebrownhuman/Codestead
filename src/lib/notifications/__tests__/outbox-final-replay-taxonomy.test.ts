import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { MAIL_IDEMPOTENCY_AUTHORITY_VERSION } from "../idempotency-authority";
import {
  PRODUCTION_EMAIL_TEMPLATES,
} from "../template-authority-policy";

const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8");
const migration = source(
  "drizzle/0067_mail_outbox_durable_replay_authority.sql",
);
const normalized = migration.toLowerCase().replace(/\s+/gu, " ").trim();

const SOURCE_MAP_POLICY_TEMPLATES = [
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

function migrationBlock(start: string, end: string) {
  const startIndex = normalized.indexOf(start);
  const endIndex = normalized.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return normalized.slice(startIndex, endIndex);
}

describe("0067 final replay taxonomy", () => {
  it("partitions exactly 22 reviewed source-map policies and seven retained strategies", () => {
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
      ...SOURCE_MAP_POLICY_TEMPLATES.map((template) => [
        template,
        "event-v1-source-map",
      ]),
      ...Object.entries(RETAINED_TEMPLATE_VERSIONS),
    ]);

    expect(actual).toEqual(expected);
    expect(Object.keys(actual)).toHaveLength(29);
    expect(SOURCE_MAP_POLICY_TEMPLATES).toHaveLength(22);
    expect(Object.keys(RETAINED_TEMPLATE_VERSIONS)).toHaveLength(7);
  });

  it("promotes only backup-status and leaves the other 21 reviewed legacy policies blocked", () => {
    const proof = migrationBlock(
      "create temp table mail_outbox_proven_legacy_source_map",
      "email outbox legacy idempotency authority payload conflict",
    );
    const promotedTemplates = [
      ...proof.matchAll(/where outbox\.template = '([^']+)'/gu),
    ].map((match) => match[1]);

    expect(promotedTemplates).toEqual(["backup-status"]);
    expect(proof).not.toMatch(
      /(?:reset-password|invitation|lost-device-proof|access-rejected|session-revocation-requested|account-deleted|inactivity-reminder|inactivity-reminder-followup|inactivity-admin-notice|daily-study-reminder|revision-reminder|goal-reminder|challenge-reminder|weekly-summary|verify-email|fallback-grant-changed|learning-plan-changed|storage-quota-changed|mastery-awarded|appeal-updated|assessment-corrected)/u,
    );
    expect(normalized).toContain(
      "set idempotency_authority_version = 'legacy-key-blocked-v1'",
    );
    expect(normalized).toContain(
      "set idempotency_authority_version = policy.authority_version",
    );
    expect(normalized).toContain(
      "set idempotency_authority_version = 'event-v1-source-map'",
    );
    expect(normalized).toContain(
      "where policy.authority_version is distinct from 'event-v1-source-map'",
    );
  });

  it("allows exactly seven identity versions with event-only authority digests", () => {
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

  it("uses conflict fingerprints for every row without treating retained keys as delivery authority", () => {
    const schema = source("src/lib/db/schema.ts");
    expect(normalized).toContain(
      "pg_catalog.to_jsonb('mail-replay-conflict-v1'::pg_catalog.text)",
    );
    expect(normalized).toContain(
      "new.idempotency_original_payload_sha256 :=",
    );
    expect(normalized).toContain(
      "new.idempotency_original_payload_sha256 is distinct from old.idempotency_original_payload_sha256",
    );
    expect(schema).toContain(
      'idempotencyOriginalPayloadSha256: text("idempotency_original_payload_sha256")',
    );
    expect(schema).toContain(
      "email_outbox_idempotency_authority_valid",
    );
  });

  it("makes event-v1-native the only post-cutover producer version", () => {
    const authority = source("src/lib/notifications/idempotency-authority.ts");
    const golden = source(
      "infra/tests/fixtures/mail-event-v1-golden-vector.json",
    );
    const writers = source(
      "src/lib/notifications/__tests__/outbox-stable-event-writers.test.ts",
    );

    expect(authority).toContain(
      'MAIL_IDEMPOTENCY_AUTHORITY_VERSION = "event-v1-native"',
    );
    expect(golden).toContain('"authorityVersion": "event-v1-native"');
    expect(writers).toContain("event-v1-native");
    expect(writers).not.toMatch(
      /(?:requires every direct outbox writer|latest-schema integration fixture)[\s\S]*?\bevent-v1\b(?!-native)/u,
    );
  });

  it("binds the logical producer registry to exactly 28 native templates and one database-owned backup source map", () => {
    const reviewedTemplates = [
      ...SOURCE_MAP_POLICY_TEMPLATES,
      ...Object.keys(RETAINED_TEMPLATE_VERSIONS),
    ];
    expect(new Set(reviewedTemplates).size).toBe(29);
    expect([...PRODUCTION_EMAIL_TEMPLATES].sort()).toEqual(
      [...reviewedTemplates].sort(),
    );

    const claimWitness = migrationBlock(
      "if new.idempotency_authority_version is null and new.idempotency_authority_sha256 is null and new.template = 'backup-status'",
      "new.idempotency_original_payload_sha256 :=",
    );
    const backupVersion = claimWitness.match(
      /new\.idempotency_authority_version := '([^']+)'/u,
    )?.[1];
    const nativeVersion = claimWitness.match(
      /new\.idempotency_authority_version is distinct from '([^']+)'/u,
    )?.[1];

    expect(MAIL_IDEMPOTENCY_AUTHORITY_VERSION).toBe("event-v1-native");
    expect(backupVersion).toBe("event-v1-source-map");
    expect(nativeVersion).toBe(MAIL_IDEMPOTENCY_AUTHORITY_VERSION);
    expect(claimWitness).toContain(
      "session_user = 'learncoding_backup_reporter'",
    );
    expect(claimWitness).toContain(
      "current_user = 'learncoding_owner'",
    );

    const actualManifest = Object.fromEntries(
      PRODUCTION_EMAIL_TEMPLATES.map((template) => [
        template,
        template === "backup-status" ? backupVersion : nativeVersion,
      ]),
    );
    const expectedManifest = Object.fromEntries(
      reviewedTemplates.map((template) => [
        template,
        template === "backup-status"
          ? "event-v1-source-map"
          : "event-v1-native",
      ]),
    );
    expect(actualManifest).toEqual(expectedManifest);
    expect(Object.values(actualManifest).filter(
      (version) => version === "event-v1-native",
    )).toHaveLength(28);
    expect(Object.values(actualManifest).filter(
      (version) => version === "event-v1-source-map",
    )).toEqual(["event-v1-source-map"]);

    const outbox = source("src/lib/notifications/outbox.ts");
    const backupReporter = source("scripts/backup/enqueue-backup-status.mjs");
    expect(outbox).toContain(
      "Email template backup-status requires its specialized producer.",
    );
    expect(outbox).toContain("MAIL_IDEMPOTENCY_AUTHORITY_VERSION");
    expect(backupReporter).toContain(
      "from public.enqueue_backup_status_mail_authority($1::text, $2::text)",
    );
    expect(backupReporter).not.toMatch(/insert\s+into\s+email_outbox/iu);
  });

  it("keeps every old and new row permanently held for task7-v1", () => {
    const hold = source(
      "src/lib/notifications/__tests__/outbox-delivery-hold-contract.test.ts",
    );
    expect(normalized).toContain(
      "update public.email_outbox set delivery_hold_version = 'task7-v1'",
    );
    expect(normalized).toContain(
      "new.delivery_hold_version := 'task7-v1'",
    );
    expect(normalized).not.toMatch(
      /set\s+delivery_hold_version\s*=\s*null/u,
    );
    expect(normalized).not.toContain("delivery_release_receipt");
    expect(hold).toContain("task7-v1");
  });
});
