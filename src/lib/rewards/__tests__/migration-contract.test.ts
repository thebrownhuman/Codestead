import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("reward integrity migration", () => {
  const migration = readFileSync(
    path.join(process.cwd(), "drizzle/0045_right_mother_askani.sql"),
    "utf8",
  );
  const deadLetterMigration = readFileSync(
    path.join(process.cwd(), "drizzle/0051_privacy_lifecycle_guards.sql"),
    "utf8",
  );

  it("backfills authoritative evidence time before enforcing its invariant", () => {
    const addColumn = migration.indexOf('ADD COLUMN "evidence_occurred_at"');
    const backfillGrant = migration.indexOf("UPDATE reward_ledger ledger");
    const backfillReversal = migration.indexOf("UPDATE reward_ledger reversal");
    const constraint = migration.indexOf("reward_ledger_evidence_time_check");
    expect(addColumn).toBeGreaterThan(-1);
    expect(backfillGrant).toBeGreaterThan(addColumn);
    expect(backfillReversal).toBeGreaterThan(backfillGrant);
    expect(constraint).toBeGreaterThan(backfillReversal);
    expect(migration).toContain("effective.updated_at");
    expect(migration).toContain("evidence.recorded_at");
    expect(migration).toContain("source.evidence_occurred_at");
  });

  it("enqueues attempts, mastery evidence, and correction projections with generation fencing", () => {
    expect(migration).toContain("reward_attempt_reconciliation_enqueue");
    expect(migration).toContain("reward_mastery_reconciliation_enqueue");
    expect(migration).toContain("reward_effective_result_reconciliation_enqueue");
    expect(migration).toContain("generation = reward_reconciliation_job.generation + 1");
    expect(migration).toContain("lease_token = null");
  });

  it("requires mastery grants to resolve an unassisted, concept-bound mastered attempt", () => {
    for (const invariant of [
      "source_attempt_status <> 'graded'",
      "source_attempt_assistance_level <> 'A0'",
      "source_attempt_solution_revealed",
      "NOT mastery_row.concept_bound",
      "NOT evidence_supported",
      "NEW.evidence_occurred_at IS DISTINCT FROM expected_evidence_at",
    ]) expect(migration).toContain(invariant);
  });

  it("allows a terminal dead-letter state for exhausted reconciliation generations", () => {
    expect(deadLetterMigration).toContain('DROP CONSTRAINT "reward_reconciliation_job_status_check"');
    expect(deadLetterMigration).toContain("'dead_letter'");
  });
});
