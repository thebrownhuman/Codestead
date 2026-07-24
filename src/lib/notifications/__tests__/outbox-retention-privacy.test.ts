import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function retentionSource() {
  return readFileSync(resolve(process.cwd(), "src/lib/data-lifecycle/retention.ts"), "utf8");
}

function terminalEmailFragments() {
  const source = retentionSource();
  const countStart = source.indexOf("const emailEligible = await count(");
  const countEnd = source.indexOf("const oldAudit = await count(", countStart);
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

describe("mail outbox retention privacy", () => {
  const fragments = terminalEmailFragments();

  it.each([
    ["eligibility count", fragments.count],
    ["bounded delete", fragments.delete],
  ] as const)("includes quarantined rows in the terminal-email %s", (_label, fragment) => {
    expect(fragment).toMatch(/status\s+in\s*\([^)]*'quarantined'[^)]*\)/u);
    expect(fragment).toContain("coalesce(sent_at, updated_at) < $1");
    expect(fragment).toContain("status = 'quarantined'");
    expect(fragment).toContain("provider_call_started is not null");
    expect(fragment).toContain("provider_message_id is null");
    expect(fragment).toMatch(/not\s*\(\s*status\s*=\s*'quarantined'/u);
  });

  it("redacts PII without destroying unresolved provider authority", () => {
    const source = retentionSource();
    const redactStart = source.indexOf("const redactedEmailAuthority =");
    const redactEnd = source.indexOf(
      "categories.unresolvedEmailDeliveryAuthority =",
      redactStart,
    );
    expect(redactStart).toBeGreaterThanOrEqual(0);
    expect(redactEnd).toBeGreaterThan(redactStart);
    const redaction = source.slice(redactStart, redactEnd);

    expect(redaction).toContain("update email_outbox");
    expect(redaction).toContain(
      "to_email = 'redacted+' || id::text || '@invalid.local'",
    );
    expect(redaction).toContain("variables = '{}'::jsonb");
    expect(redaction).toContain("status = 'quarantined'");
    expect(redaction).toContain("provider_call_started is not null");
    expect(redaction).toContain("provider_message_id is null");
    expect(redaction).toContain("returning id");
    expect(redaction).not.toMatch(/user_id\s*=/u);
    expect(redaction).not.toMatch(/delivery_scope_key\s*=/u);
    expect(redaction).not.toMatch(/operation_id\s*=/u);
    expect(redaction).not.toMatch(/provider_call_started\s*=/u);
    expect(redaction).not.toMatch(/provider_message_id\s*=/u);
    expect(redaction).not.toMatch(/claim_token\s*=/u);
    expect(redaction).not.toMatch(/claim_owner\s*=/u);
  });
});
