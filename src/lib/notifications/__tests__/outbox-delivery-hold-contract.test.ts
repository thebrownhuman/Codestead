import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const readRepositoryFile = (...segments: string[]) =>
  readFileSync(resolve(repositoryRoot, ...segments), "utf8");

const migration0067 = readRepositoryFile(
  "drizzle",
  "0067_mail_outbox_durable_replay_authority.sql",
);
const migration0063 = readRepositoryFile(
  "drizzle",
  "0063_mail_outbox_redaction_fence_release.sql",
);
const store = readRepositoryFile(
  "src",
  "lib",
  "notifications",
  "postgres-outbox-store.ts",
);
const schema = readRepositoryFile("src", "lib", "db", "schema.ts");
const deletion = readRepositoryFile(
  "src",
  "lib",
  "data-lifecycle",
  "deletion.ts",
);
const retention = readRepositoryFile(
  "src",
  "lib",
  "data-lifecycle",
  "retention.ts",
);
const liveHarness = readRepositoryFile(
  "infra",
  "tests",
  "mail-durable-replay-0067.impl.mjs",
);
const snapshot = JSON.parse(
  readRepositoryFile("drizzle", "meta", "0067_snapshot.json"),
) as {
  tables?: Record<string, {
    columns?: Record<string, {
      default?: unknown;
      notNull?: unknown;
      type?: unknown;
    }>;
  }>;
};

function normalize(source: string) {
  return source.toLowerCase().replace(/\s+/gu, " ").trim();
}

function sourceBlock(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

function tailBlock(source: string, start: string) {
  const startIndex = source.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  return source.slice(startIndex);
}

function javascriptFunctionBlock(source: string, signature: string) {
  const startIndex = source.indexOf(signature);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const remainder = source.slice(startIndex + signature.length);
  const nextFunction = remainder.search(/\n(?:async\s+)?function\s+\w+/u);
  const endIndex = nextFunction < 0
    ? source.length
    : startIndex + signature.length + nextFunction;
  return source.slice(startIndex, endIndex);
}

const normalized0067 = normalize(migration0067);
const normalized0063 = normalize(migration0063);
const normalizedStore = normalize(store);
const normalizedDeletion = normalize(deletion);
const normalizedRetention = normalize(retention);

describe("0067 Task 5 delivery hold contract", () => {
  it("backfills and permanently constrains every row to task7-v1 before classification", () => {
    expect(normalized0067).toMatch(
      /add column delivery_hold_version (?:pg_catalog\.)?text(?:,|;)/u,
    );
    const backfillStatement = sourceBlock(
      normalized0067,
      "update public.email_outbox set delivery_hold_version = 'task7-v1'",
      ";--> statement-breakpoint",
    );
    expect(backfillStatement).not.toContain(" where ");
    expect(
      normalized0067.indexOf(
        "update public.email_outbox set delivery_hold_version = 'task7-v1'",
      ),
    ).toBeLessThan(
      normalized0067.indexOf(
        "update public.email_outbox set idempotency_authority_version = 'legacy-key-blocked-v1'",
      ),
    );

    expect(normalized0067).toContain(
      "alter column delivery_hold_version set not null",
    );
    expect(normalized0067).toContain(
      "constraint email_outbox_delivery_hold_valid check ((delivery_hold_version = 'task7-v1') is true)",
    );
    expect(normalized0067).not.toMatch(
      /delivery_hold_version\s+is\s+null\s+or/u,
    );
    expect(normalized0067).not.toContain("default 'task7-v1'");

    const schemaColumn = schema.match(
      /deliveryHoldVersion:\s*text\("delivery_hold_version"\)[\s\S]{0,160}/u,
    )?.[0];
    expect(schemaColumn).toContain(".notNull()");
    const snapshotColumn =
      snapshot.tables?.["public.email_outbox"]?.columns?.[
        "delivery_hold_version"
      ];
    expect(snapshotColumn?.type).toBe("text");
    expect(snapshotColumn?.notNull).toBe(true);
    expect(snapshotColumn).not.toHaveProperty("default");
  });

  it("forces every INSERT form held and contains no Task 5 release path", () => {
    const insertGuard = sourceBlock(
      normalized0067,
      "create function public.claim_email_outbox_idempotency_authority()",
      "create function public.persist_email_outbox_idempotency_authority()",
    );
    expect(
      insertGuard.match(/new\.delivery_hold_version := 'task7-v1'/gu) ?? [],
    ).toHaveLength(1);
    expect(
      insertGuard.indexOf("new.delivery_hold_version := 'task7-v1'"),
    ).toBeLessThan(
      insertGuard.indexOf(
        "if new.idempotency_original_payload_sha256 is not null",
      ),
    );
    for (const pristinePredicate of [
      "new.status is distinct from 'pending'",
      "new.attempt_count is distinct from 0",
      "new.claim_token is not null",
      "new.claim_owner is not null",
      "new.claim_version is distinct from 0",
      "new.lease_expires_at is not null",
      "new.provider_call_started is not null",
      "new.adapter is not null",
      "new.dispatch_binding_version is not null",
      "new.dispatch_binding_sha256 is not null",
      "new.provider_correlation_version is not null",
      "new.provider_evidence_version is not null",
      "new.provider_evidence_sha256 is not null",
      "new.provider_message_id is not null",
      "new.sent_at is not null",
      "new.quarantined_at is not null",
      "new.last_error_code is not null",
    ]) {
      expect(insertGuard).toContain(pristinePredicate);
    }
    expect(insertGuard).toContain(
      "email outbox delivery state must be pristine while held",
    );
    expect(insertGuard).toContain(
      "constraint = 'email_outbox_delivery_hold_valid'",
    );
    expect(
      insertGuard.indexOf(
        "email outbox delivery state must be pristine while held",
      ),
    ).toBeLessThan(
      insertGuard.indexOf("new.delivery_hold_version := 'task7-v1'"),
    );
    expect(normalized0067).toContain(
      "enable always trigger email_outbox_idempotency_claim",
    );

    expect(normalized0067).not.toMatch(
      /set\s+delivery_hold_version\s*=\s*null/u,
    );
    expect(normalized0067).not.toMatch(
      /delivery_hold_version\s*:=\s*null/u,
    );
    expect(normalized0067).not.toContain("mail_delivery_release_receipt");
    expect(normalized0067).not.toContain("release_email_outbox_delivery");
    expect(normalized0067).not.toContain("promote_email_outbox_delivery");
  });

  it("fails the cutover before persistent 0067 changes when work is live", () => {
    const firstPersistentChange = normalized0067.indexOf(
      "alter table public.backup_status_mail_authority",
    );
    expect(firstPersistentChange).toBeGreaterThanOrEqual(0);
    const preflight = normalized0067.slice(0, firstPersistentChange);
    expect(preflight).toContain("from public.email_outbox");
    expect(preflight).toContain("status = 'sending'");
    expect(preflight).toContain("claim_token is not null");
    expect(preflight).toContain("claim_owner is not null");
    expect(preflight).toContain("lease_expires_at is not null");
    expect(preflight).toMatch(
      /lease_expires_at\s*>=\s*pg_catalog\.statement_timestamp\(\)/u,
    );
    expect(preflight).toContain(
      "email outbox delivery cutover requires quiescence",
    );
    expect(preflight).toContain("errcode = '23514'");
  });

  it("uses an ALWAYS UPDATE-only guard for held delivery state", () => {
    const guard = sourceBlock(
      normalized0067,
      "create function public.enforce_email_outbox_delivery_hold()",
      "create function public.claim_email_outbox_idempotency_authority()",
    );
    expect(guard).toContain(
      "if old.delivery_hold_version = 'task7-v1'",
    );
    for (const column of [
      "idempotency_authority_version",
      "idempotency_authority_sha256",
      "idempotency_original_payload_sha256",
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
      "delivery_hold_version",
    ]) {
      expect(guard).toContain(
        `new.${column} is distinct from old.${column}`,
      );
    }
    expect(guard).toContain(
      "raise exception 'email outbox delivery remains held for task7-v1'",
    );
    expect(guard).toContain("errcode = '23514'");
    expect(normalized0067).toContain(
      "create trigger email_outbox_delivery_hold before update of",
    );
    expect(normalized0067).not.toContain(
      "create trigger email_outbox_delivery_hold before update or delete",
    );
    expect(normalized0067).toContain(
      "enable always trigger email_outbox_delivery_hold",
    );
    expect(guard).not.toContain("tg_op");
    expect(guard).not.toContain("session_user");
    expect(guard).not.toContain(
      "classify_email_outbox_retention_redaction",
    );
    expect(guard).not.toContain("interval '30 days'");
    expect(guard).not.toContain("new.to_email");
    expect(guard).not.toContain("new.variables");
    expect(guard).not.toContain("new.updated_at");
  });

  it("preserves 0063 redaction and lifecycle-owned physical deletion", () => {
    expect(normalized0067).not.toContain(
      "create or replace function public.classify_email_outbox_retention_redaction",
    );
    expect(normalized0067).not.toContain(
      "create or replace function public.redact_unresolved_email_outbox_authority",
    );
    expect(normalized0067).not.toContain(
      "create or replace function public.enforce_email_outbox_payload_immutable",
    );
    expect(normalized0063).toContain(
      "current_user = 'learncoding_owner' and session_user = 'learncoding_ops'",
    );
    expect(normalized0063).toContain(
      "\"public\".\"classify_email_outbox_retention_redaction\"( old, pg_catalog.statement_timestamp() - interval '30 days' )",
    );
    expect(normalized0063).toContain(
      "new.to_email = expected_email",
    );
    expect(normalized0063).toContain(
      "new.variables = expected_variables",
    );
    expect(normalized0063).toContain(
      "new.updated_at = pg_catalog.statement_timestamp()",
    );

    expect(normalized0067).toContain(
      "create trigger email_outbox_idempotency_append_only",
    );
    expect(normalized0067).toContain(
      "create trigger email_outbox_idempotency_no_truncate",
    );
    expect(normalized0067).toContain("on delete restrict");

    expect(normalizedDeletion).toMatch(
      /from email_outbox where user_id = \$1 or lower\(to_email\) = lower\(\$2\) order by id for update/u,
    );
    expect(normalizedDeletion).toContain(
      "row.status === \"quarantined\" && row.provider_call_started !== null && row.provider_message_id === null",
    );
    expect(normalizedDeletion).toContain(
      "\"delete from email_outbox where user_id = $1 or lower(to_email) = lower($2)\"",
    );
    expect(normalizedRetention).toContain(
      "status = 'quarantined' and provider_call_started is not null and provider_message_id is null",
    );
  });

  it("places an independent deny-all hold gate on every delivery mutation", () => {
    const claim = sourceBlock(
      normalizedStore,
      "async claimnext(",
      "async beginprovidercall(",
    );
    const holdPredicates =
      claim.match(/delivery_hold_version is null/gu) ?? [];
    expect(holdPredicates).toHaveLength(2);
    const candidateHold = claim.indexOf(
      "candidate.delivery_hold_version is null",
    );
    const outerLimit = claim.indexOf("limit 16");
    const casHold = claim.indexOf(
      "delivery_hold_version is null",
      outerLimit,
    );
    expect(candidateHold).toBeGreaterThanOrEqual(0);
    expect(candidateHold).toBeLessThan(outerLimit);
    expect(casHold).toBeGreaterThan(outerLimit);
    expect(claim).not.toContain(
      "active.delivery_hold_version is null",
    );
    expect(claim).toMatch(
      /active\.status = 'quarantined'[\s\S]*active\.provider_call_started is not null[\s\S]*active\.provider_message_id is null/u,
    );

    const decision = sourceBlock(
      normalizedStore,
      "async function providerboundarydecision(",
      "function claimfromrow(",
    );
    expect(decision).toContain(
      "and outbox.delivery_hold_version is null",
    );
    const providerStart = sourceBlock(
      normalizedStore,
      "async beginprovidercall(",
      "async finishbeforeprovider(",
    );
    expect(providerStart).toContain(
      "and outbox.delivery_hold_version is null",
    );

    const reconciliationDiscovery = sourceBlock(
      normalizedStore,
      "async findgmailreconciliationfence(",
      "async finalizegmailreconciliation(",
    );
    expect(reconciliationDiscovery).toContain(
      "delivery_hold_version is null",
    );
    const reconciliationFinalization = sourceBlock(
      normalizedStore,
      "async finalizegmailreconciliation(",
      "async claimnext(",
    );
    expect(
      reconciliationFinalization.match(
        /delivery_hold_version is null/gu,
      )?.length,
    ).toBeGreaterThanOrEqual(2);
    const sweep = tailBlock(
      normalizedStore,
      "async quarantineabandoned(",
    );
    expect(
      sweep.match(/delivery_hold_version is null/gu),
    ).toHaveLength(2);

    const audience = sourceBlock(
      normalizedStore,
      "function systemaudienceauthoritypredicate(",
      "function systemmailauthoritypredicate(",
    );
    expect(audience).not.toContain("idempotency_authority_version");
    expect(audience).not.toContain("idempotency_authority_sha256");
    expect(audience).not.toContain(
      "idempotency_original_payload_sha256",
    );
    expect(decision).not.toMatch(
      /delivery_hold_version is null\s+or\s+outbox\.idempotency_/u,
    );
    expect(providerStart).not.toMatch(
      /delivery_hold_version is null\s+or\s+outbox\.idempotency_/u,
    );
  });

  it("requires deterministic live PG17/PG18 evidence for all bypasses", () => {
    const holdProof = javascriptFunctionBlock(
      liveHarness,
      "async function proveDeliveryHoldAuthority",
    );
    for (const marker of [
      "delivery-hold-quiescence-sending",
      "delivery-hold-quiescence-claim-token",
      "delivery-hold-quiescence-claim-owner",
      "delivery-hold-quiescence-live-lease",
      "delivery-hold-cutover-rollback",
      "delivery-hold-backfill-all",
      "delivery-hold-explicit-null-insert",
      "delivery-hold-explicit-other-insert",
      "delivery-hold-nonpristine-insert-denied",
      "delivery-hold-copy-nonnull-denied",
      "delivery-hold-copy-forced",
      "delivery-hold-merge-denied",
      "delivery-hold-replica-update-denied",
      "delivery-hold-replica-insert-nonnull-denied",
      "delivery-hold-replica-insert-forced",
      "delivery-hold-direct-sent-denied",
      "delivery-hold-direct-failed-denied",
      "delivery-hold-direct-suppressed-denied",
      "delivery-hold-claim-denied",
      "delivery-hold-reclaim-denied",
      "delivery-hold-provider-denied",
      "delivery-hold-sweep-denied",
      "delivery-hold-reconcile-denied",
      "delivery-hold-scope-blocker",
      "delivery-hold-zero-eligible",
      "delivery-hold-redaction-preserved",
      "delivery-hold-account-delete-preserved",
      "delivery-hold-replay-guard-preserved",
    ]) {
      expect(holdProof).toContain(marker);
    }
    expect(holdProof).toContain(
      "email outbox delivery remains held for task7-v1",
    );
    expect(holdProof).toContain("session_replication_role = replica");
    expect(holdProof.toLowerCase()).toContain(
      "copy public.email_outbox",
    );
    expect(holdProof.toLowerCase()).toContain(
      "merge into public.email_outbox",
    );
    expect(holdProof).not.toContain("pg_sleep");
    expect(liveHarness).toContain(
      "await proveDeliveryHoldAuthority(port, \"mail0067\")",
    );
  });
});
