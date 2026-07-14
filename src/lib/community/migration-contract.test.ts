import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("community moderation idempotency migration contract", () => {
  it("widens the receipt action constraint and journals the forward migration", async () => {
    const [sql, journalText] = await Promise.all([
      readFile(path.join(process.cwd(), "drizzle/0053_community_moderation_idempotency.sql"), "utf8"),
      readFile(path.join(process.cwd(), "drizzle/meta/_journal.json"), "utf8"),
    ]);

    expect(sql).toContain('DROP CONSTRAINT "community_operation_receipt_action_check"');
    expect(sql).toContain('ADD CONSTRAINT "community_operation_receipt_action_check"');
    expect(sql).toContain("'create_group','add_member','create_post','reply','moderate'");
    const journal = JSON.parse(journalText) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.at(-1)).toMatchObject({
      idx: 53,
      tag: "0053_community_moderation_idempotency",
    });
  });
});
