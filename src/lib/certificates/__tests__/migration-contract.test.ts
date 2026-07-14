import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("career, certificate, and public portfolio migration contract", () => {
  const sql = readFileSync(path.join(process.cwd(), "drizzle/0047_odd_drax.sql"), "utf8");
  const selectionGuardFixSql = readFileSync(
    path.join(process.cwd(), "drizzle/0050_public_portfolio_selection_guard_fix.sql"),
    "utf8",
  );

  it("creates every owner-bound table and its database authority guard", () => {
    for (const table of [
      "career_card", "career_card_prerequisite", "career_card_event",
      "course_certificate", "certificate_revocation", "certificate_operation_receipt",
      "public_portfolio", "public_portfolio_project", "public_portfolio_achievement",
      "public_portfolio_certificate", "public_portfolio_event",
    ]) expect(sql).toContain(`CREATE TABLE "${table}"`);
    for (const trigger of [
      "career_card_authority_guard_trigger",
      "certificate_issue_guard_trigger",
      "certificate_revocation_authority_guard_trigger",
      "public_portfolio_project_selection_guard_trigger",
      "public_portfolio_achievement_selection_guard_trigger",
      "public_portfolio_certificate_selection_guard_trigger",
    ]) expect(sql).toContain(`CREATE TRIGGER "${trigger}"`);
  });

  it("builds composite owner indexes before dependent foreign keys", () => {
    const contracts = [
      ["course_certificate_id_user_unique", "certificate_operation_receipt_certificate_owner_fk"],
      ["project_id_user_unique", "public_portfolio_project_owner_fk"],
      ["user_achievement_id_user_unique", "public_portfolio_achievement_owner_fk"],
    ] as const;
    for (const [index, foreignKey] of contracts) {
      expect(sql.indexOf(`CREATE UNIQUE INDEX "${index}"`)).toBeGreaterThan(-1);
      expect(sql.indexOf(`CREATE UNIQUE INDEX "${index}"`))
        .toBeLessThan(sql.indexOf(`ADD CONSTRAINT "${foreignKey}"`));
    }
  });

  it("serializes issue/revocation requests and protects immutable evidence", () => {
    expect(sql).toContain("certificate_operation_receipt_user_id_request_id_pk");
    expect(sql).toContain("certificate_revocation_request_unique");
    expect(sql).toContain("course_certificate_enrollment_unique");
    expect(sql).toContain("course_certificate_append_only_trigger");
    expect(sql).toContain("certificate_revocation_append_only_trigger");
    expect(sql).toContain("certificate_operation_receipt_append_only_trigger");
    expect(sql).toContain("public_portfolio_event_append_only_trigger");
    expect(sql).toContain("current verified course version");
    expect(sql).toContain("mastered concepts backed by valid evidence");
  });

  it("upgrades the shared portfolio guard to table-specific owner checks", () => {
    for (const trigger of [
      "public_portfolio_project_selection_guard_trigger",
      "public_portfolio_achievement_selection_guard_trigger",
      "public_portfolio_certificate_selection_guard_trigger",
    ]) {
      expect(selectionGuardFixSql).toContain(`DROP TRIGGER IF EXISTS "${trigger}"`);
      expect(selectionGuardFixSql).toContain(`CREATE TRIGGER "${trigger}"`);
    }

    expect(selectionGuardFixSql).toContain(
      'DROP FUNCTION IF EXISTS "public_portfolio_selection_guard"()',
    );
    for (const guard of [
      "public_portfolio_project_selection_guard",
      "public_portfolio_achievement_selection_guard",
      "public_portfolio_certificate_selection_guard",
    ]) {
      expect(selectionGuardFixSql).toContain(`CREATE FUNCTION "${guard}"()`);
      expect(selectionGuardFixSql).toContain(`EXECUTE FUNCTION "${guard}"()`);
    }

    expect(selectionGuardFixSql).toContain("owned.id = NEW.project_id");
    expect(selectionGuardFixSql).toContain("owned.id = NEW.user_achievement_id");
    expect(selectionGuardFixSql).toContain("owned.id = NEW.certificate_id");
  });
});
