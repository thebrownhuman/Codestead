import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function retentionSource() {
  return readFileSync(resolve(process.cwd(), "src/lib/data-lifecycle/retention.ts"), "utf8");
}

function terminalEmailFragments() {
  const source = retentionSource();
  const countStart = source.indexOf("const emailEligible = await count(");
  const countEnd = source.indexOf("const nonExternalConsoleEmailEligible = await count(", countStart);
  const deleteStart = source.indexOf("const deletedEmail = await client.query<IdRow>(");
  const deleteEnd = source.indexOf("categories.terminalEmailDeliveryRecords =", deleteStart);

  expect(countStart).toBeGreaterThanOrEqual(0);
  expect(countEnd).toBeGreaterThan(countStart);
  expect(deleteStart).toBeGreaterThanOrEqual(0);
  expect(deleteEnd).toBeGreaterThan(deleteStart);

  return {
    count: source.slice(countStart, countEnd),
    delete: source.slice(deleteStart, deleteEnd),
  };
}

function nonExternalConsoleFragments() {
  const source = retentionSource();
  const countStart = source.indexOf("const nonExternalConsoleEmailEligible = await count(");
  const countEnd = source.indexOf("const oldAudit = await count(", countStart);
  const deleteStart = source.indexOf("const deletedNonExternalConsoleEmail = await client.query<IdRow>(");
  const deleteEnd = source.indexOf(
    "categories.nonExternalConsoleDeliveryQuarantines =",
    deleteStart,
  );

  expect(countStart).toBeGreaterThanOrEqual(0);
  expect(countEnd).toBeGreaterThan(countStart);
  expect(deleteStart).toBeGreaterThanOrEqual(0);
  expect(deleteEnd).toBeGreaterThan(deleteStart);

  return {
    count: source.slice(countStart, countEnd),
    delete: source.slice(deleteStart, deleteEnd),
  };
}

describe("mail outbox retention privacy", () => {
  const fragments = terminalEmailFragments();
  const consoleFragments = nonExternalConsoleFragments();

  it.each([
    ["eligibility count", fragments.count],
    ["bounded delete", fragments.delete],
  ] as const)("keeps only pre-provider and exact full-receipt quarantines terminal in the %s", (_label, fragment) => {
    expect(fragment).toMatch(/status\s+in\s*\([^)]*'sent'[^)]*'suppressed'[^)]*'failed'[^)]*\)/u);
    expect(fragment).toContain(
      "case when status = 'quarantined' and sent_at is null then quarantined_at else coalesce(sent_at, updated_at) end < $1",
    );
    expect(fragment).toContain("status = 'quarantined'");
    expect(fragment).toContain("provider_call_started is null");
    expect(fragment).toContain("provider_message_id is not null");
    expect(fragment).toContain("sent_at is not null");
  });

  it("redacts PII without destroying unresolved provider authority", () => {
    const source = retentionSource();
    const redactStart = source.indexOf("from public.redact_quarantined_email_outbox_authority_v2(");
    const redactEnd = source.indexOf(
      "categories.unresolvedEmailDeliveryAuthority =",
      redactStart,
    );
    expect(redactStart).toBeGreaterThanOrEqual(0);
    expect(redactEnd).toBeGreaterThan(redactStart);
    const redaction = source.slice(redactStart, redactEnd);

    expect(redaction).toContain(
      "from public.redact_quarantined_email_outbox_authority_v2(",
    );
    expect(redaction).toContain("$1::timestamptz, $2::integer");
    expect(redaction).toContain("eligibleTransitioned > batchLimit");
    expect(redaction).toContain(
      "malformedTransitioned > batchLimit - eligibleTransitioned",
    );
    expect(redaction).not.toContain("update email_outbox");
  });

  it("contains redaction in a same-client savepoint and surfaces stable retry health", () => {
    const source = retentionSource();

    expect(source).toContain('client.query("savepoint retention_email_redaction")');
    expect(source).toContain('client.query("rollback to savepoint retention_email_redaction")');
    expect(source).toContain('client.query("release savepoint retention_email_redaction")');
    expect(source).toContain("EMAIL_OUTBOX_REDACTION_RETRYABLE");
    expect(source).toContain('outcome: "failed"');
    expect(source).toContain('outcome: "completed_with_errors"');
    expect(source).toContain("requiresRetry: true");
  });

  it("uses v2 as the sole unresolved-PII classifier while preserving report keys", () => {
    const source = retentionSource();

    expect(source).toContain("const nonExternalConsoleEmailEligible = await count(");
    expect(source).not.toContain("const unclassifiedEmailAuthorityRepairRequired = await count(");
    expect(source).not.toContain("const unclassifiedEmailAuthorityBlocked = await count(");
    expect(source).toContain("categories.nonExternalConsoleDeliveryQuarantines =");
    expect(source).toContain("categories.unclassifiedEmailDeliveryAuthorityRepairRequired =");
    expect(source).toContain("categories.unclassifiedEmailDeliveryAuthorityBlocked =");
    expect(source).not.toContain("/* unresolved_email_redaction_domain */");
    expect(source).not.toContain("public.classify_email_outbox_retention_redaction");
  });

  it.each([
    ["eligibility count", fragments.count],
    ["bounded delete", fragments.delete],
  ] as const)(
    "requires an exact released successor for post-boundary terminal deletion in the %s",
    (_label, fragment) => {
      expect(fragment).toContain("claim_version >= 2");
      expect(fragment).toContain("claim_token is null");
      expect(fragment).toContain("claim_owner is null");
      expect(fragment).toContain("lease_expires_at is null");
      expect(fragment).toContain("last_error_code = 'ABANDONED_POST_PROVIDER_BOUNDARY'");
      expect(fragment).toContain("adapter = 'gmail'");
      expect(fragment).toContain("dispatch_binding_version = 'gmail-raw-v1'");
      expect(fragment).toContain("dispatch_binding_sha256 ~ '^[0-9a-f]{64}$'");
      expect(fragment).toContain("provider_message_id is not null");
      expect(fragment).toContain("sent_at is not null");
      expect(fragment).toContain("delivery_scope_key = 'a:' || user_id");
      expect(fragment).toContain("delivery_scope_key = 's:' || operation_id::text");
    },
  );

  it.each([
    ["eligibility count", consoleFragments.count],
    ["bounded delete", consoleFragments.delete],
  ] as const)("deletes only an exact released no-receipt console successor in the %s", (_label, fragment) => {
    expect(fragment).toContain("claim_version >= 2");
    expect(fragment).toContain("claim_token is null");
    expect(fragment).toContain("claim_owner is null");
    expect(fragment).toContain("lease_expires_at is null");
    expect(fragment).toContain("last_error_code = 'ABANDONED_POST_PROVIDER_BOUNDARY'");
    expect(fragment).toContain("adapter = 'console'");
    expect(fragment).toContain("dispatch_binding_version = 'console-json-v1'");
    expect(fragment).toContain("dispatch_binding_sha256 ~ '^[0-9a-f]{64}$'");
    expect(fragment).toContain("provider_message_id is null");
    expect(fragment).toContain("sent_at is null");
    expect(fragment).toContain("quarantined_at < $1::timestamptz");
    expect(fragment).toContain("delivery_scope_key = 'a:' || user_id");
    expect(fragment).toContain("delivery_scope_key = 's:' || operation_id::text");
  });
});
