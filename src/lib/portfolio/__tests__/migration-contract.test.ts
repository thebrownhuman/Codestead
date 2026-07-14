import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("public portfolio snapshot migration contract", () => {
  it("records the forward-only shared replay and immutable projection migration", async () => {
    const [sql, journalText] = await Promise.all([
      readFile(path.join(process.cwd(), "drizzle/0052_public_portfolio_project_snapshots.sql"), "utf8"),
      readFile(path.join(process.cwd(), "drizzle/meta/_journal.json"), "utf8"),
    ]);
    expect(sql).toContain('CREATE TABLE "community_operation_receipt"');
    expect(sql).toContain('CREATE TABLE "public_portfolio_project_snapshot"');
    expect(sql).toContain('CONSTRAINT "public_portfolio_project_snapshot_owner_fk"');
    expect(sql).toContain('CREATE TRIGGER "public_portfolio_project_snapshot_update_guard"');
    expect(sql).toContain("public_portfolio_project_snapshot is immutable");
    const journal = JSON.parse(journalText) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.find(({ tag }) => tag === "0052_public_portfolio_project_snapshots")).toMatchObject({
      idx: 52,
      tag: "0052_public_portfolio_project_snapshots",
    });
  });
});
