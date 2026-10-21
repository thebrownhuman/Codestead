import { describe, expect, it } from "vitest";

import { matchesSqlResult, type SqlResult } from "../compare";

const expected = { columns: ["name", "count"], rows: [["Ada", 2], ["Grace", null]], orderSensitive: true };

describe("SQL result comparison", () => {
  it("matches ordered columns and typed cells including NULL", () => {
    expect(matchesSqlResult(expected, expected)).toBe(true);
    expect(matchesSqlResult({ ...expected, rows: [["Ada", "2"], ["Grace", null]] }, expected)).toBe(false);
    expect(matchesSqlResult({ ...expected, rows: [["Ada", 2], ["Grace", "NULL"]] }, expected)).toBe(false);
  });

  it("requires exact column names and order even when row order is ignored", () => {
    for (const columns of [["name"], ["count", "name"], ["Name", "count"]]) {
      expect(matchesSqlResult({ ...expected, columns }, { ...expected, orderSensitive: false })).toBe(false);
    }
  });

  it("respects the order-sensitive flag without mutating either result", () => {
    const actual = { ...expected, rows: [...expected.rows].reverse() };
    const before = structuredClone(actual);
    expect(matchesSqlResult(actual, expected)).toBe(false);
    expect(matchesSqlResult(actual, { ...expected, orderSensitive: false })).toBe(true);
    expect(actual).toEqual(before);
    expect(expected.rows[0]).toEqual(["Ada", 2]);
  });

  it("compares unordered rows as a multiset, retaining duplicates", () => {
    const duplicates = { columns: ["x"], rows: [[1], [1], [2]], orderSensitive: false };
    expect(matchesSqlResult({ columns: ["x"], rows: [[2], [1], [1]] }, duplicates)).toBe(true);
    expect(matchesSqlResult({ columns: ["x"], rows: [[2], [2], [1]] }, duplicates)).toBe(false);
  });

  it.each<SqlResult>([
    { columns: expected.columns, rows: [["Ada", 2]] },
    { columns: expected.columns, rows: [...expected.rows, ["Linus", 3]] },
    { columns: expected.columns, rows: [["Ada"], ["Grace", null]] },
    { columns: expected.columns, rows: [["Ada", 2, 3], ["Grace", null]] },
    { columns: expected.columns, rows: [["Ada", 2], ["Other", null]] },
  ])("rejects missing, extra, malformed or different rows: %j", (actual) => {
    expect(matchesSqlResult(actual, expected)).toBe(false);
  });

  it("matches empty results only with the expected columns", () => {
    const empty = { columns: ["x"], rows: [], orderSensitive: false };
    expect(matchesSqlResult(empty, empty)).toBe(true);
    expect(matchesSqlResult({ columns: [], rows: [] }, empty)).toBe(false);
  });

  it("does not coerce booleans, strings, numbers, dates, or structured values", () => {
    for (const [actual, expectedValue] of [[false, 0], [true, "true"], [new Date(0), "1970-01-01"], [{ x: 1 }, "[object Object]"]]) {
      expect(matchesSqlResult({ columns: ["x"], rows: [[actual]] }, {
        columns: ["x"], rows: [[expectedValue as string | number]], orderSensitive: true,
      })).toBe(false);
    }
    expect(matchesSqlResult({ columns: ["x"], rows: [[false], [true]] }, {
      columns: ["x"], rows: [[false], [true]], orderSensitive: true,
    })).toBe(true);
  });
});
