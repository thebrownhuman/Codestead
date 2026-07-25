import { describe, expect, it } from "vitest";

import {
  requireSuccessfulFullSchemaArchiveDump,
  type FullSchemaArchiveChildResult,
} from "../lib/full-schema-restore-archive";

function result(
  stdout: Buffer,
  overrides: Partial<FullSchemaArchiveChildResult> = {},
): FullSchemaArchiveChildResult {
  return {
    exitCode: 0,
    failed: false,
    signalCode: null,
    stdout,
    ...overrides,
  };
}

describe("full-schema restore archive result authority", () => {
  it("returns the exact successful non-empty dump buffer", () => {
    const archive = Buffer.from("archive");
    expect(requireSuccessfulFullSchemaArchiveDump(
      result(archive),
    )).toBe(archive);
  });

  it.each([
    { exitCode: 1 },
    { failed: true },
    { signalCode: "SIGTERM" as const },
  ])("zeros partial pg_dump stdout before failing closed: %#", (
    failure,
  ) => {
    const partial = Buffer.from("sensitive-partial-archive");

    expect(() => requireSuccessfulFullSchemaArchiveDump(result(
      partial,
      failure,
    ))).toThrow("full-schema restore dump failed");

    expect(partial.every((value) => value === 0)).toBe(true);
  });

  it("rejects and zeroes an empty dump buffer", () => {
    const empty = Buffer.alloc(0);
    expect(() => requireSuccessfulFullSchemaArchiveDump(result(empty)))
      .toThrow("full-schema restore dump failed");
  });
});
