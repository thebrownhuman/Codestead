import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const raceHarness = readFileSync(
  resolve(
    process.cwd(),
    "integration",
    "mail-delivery-races.integration.test.ts",
  ),
  "utf8",
).toLowerCase();

describe("mail delivery race cleanup contract", () => {
  it("preserves the immutable 0065 authority ledger and admin guard", () => {
    expect(raceHarness).toContain("'backup_status_mail_authority'");
    expect(raceHarness).toContain("'backup_status_mail_admin_guard'");
    expect(raceHarness).toMatch(
      /table_name\s+not\s+in\s*\(\s*'backup_status_mail_authority',\s*'backup_status_mail_admin_guard'\s*\)/u,
    );
  });
});
