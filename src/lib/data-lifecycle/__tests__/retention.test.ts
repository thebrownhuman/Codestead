import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  RetentionRunConflictError,
  runRetention,
} from "../retention";

describe("retention job guardrails", () => {
  it("counts immutable public project snapshots as durable portfolio evidence", () => {
    const source = readFileSync(path.join(process.cwd(), "src/lib/data-lifecycle/retention.ts"), "utf8");

    expect(source).toContain("from public_portfolio_project_snapshot");
    expect(source).toContain(":project-snapshot:");
    expect(source).toContain("portfolio_version::text");
  });

  it.each([0, -1, 5_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects unsafe batch size %s before opening a database connection",
    async (batchSize) => {
      await expect(runRetention({
        idempotencyKey: "retention:test:invalid-batch",
        dryRun: true,
        batchSize,
      })).rejects.toThrow(/batchSize/i);
    },
  );

  it.each(["short", " spaces are unsafe ", "slash/is/unsafe", "x".repeat(201)])(
    "rejects unsafe idempotency key %s before opening a database connection",
    async (idempotencyKey) => {
      await expect(runRetention({ idempotencyKey, dryRun: true })).rejects.toThrow(/idempotencyKey/i);
    },
  );

  it("rejects an invalid immutable evaluation timestamp", async () => {
    await expect(runRetention({
      idempotencyKey: "retention:test:invalid-date",
      dryRun: true,
      now: new Date(Number.NaN),
    })).rejects.toThrow(/timestamp/i);
  });

  it.each([
    ["RUN_IN_PROGRESS", "in progress"],
    ["PREVIOUS_RUN_FAILED", "prior lifecycle run"],
    ["IDEMPOTENCY_MISMATCH", "different lifecycle operation or input"],
  ] as const)("returns a stable safe conflict for %s", (code, phrase) => {
    const error = new RetentionRunConflictError(code);
    expect(error.code).toBe(code);
    expect(error.message.toLowerCase()).toContain(phrase);
  });
});
