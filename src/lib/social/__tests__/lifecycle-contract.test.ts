import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("social data lifecycle coverage", () => {
  const root = process.cwd();
  const read = (file: string) => readFileSync(path.join(root, file), "utf8");

  it("includes profile history and private score evidence in export and deletion", () => {
    const exportSource = read("src/lib/data-lifecycle/export.ts");
    const deletionSource = read("src/lib/data-lifecycle/deletion.ts");
    for (const table of ["cohort_profile", "cohort_profile_event", "leaderboard_score_snapshot"]) {
      expect(exportSource).toContain(table);
      expect(deletionSource).toContain(table);
    }
    expect(deletionSource).toContain("delete from consent_record where user_id = $1");
  });

  it("documents recipients and account-lifetime erasure for every social table", () => {
    const inventory = read("docs/privacy-data-inventory.md");
    for (const table of ["cohort_profile", "cohort_profile_event", "leaderboard_score_snapshot"]) {
      expect(inventory).toContain(`\`${table}\``);
    }
    expect(inventory).toContain("removed on account deletion");
    expect(inventory).toContain("cohort receives only rank, alias, total and component/count aggregates");
  });
});
