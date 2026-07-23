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
  });
});
