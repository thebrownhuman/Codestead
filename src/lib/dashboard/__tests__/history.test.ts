import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { buildDashboardActivityQuery, projectDashboardActivitySummary } from "../history";

describe("dashboard history aggregation", () => {
  it("returns a single summary with seven weekly buckets instead of history rows", () => {
    const query = new PgDialect().sqlToQuery(buildDashboardActivityQuery("owner", new Date("2026-10-01T12:00:00Z"), "UTC", "2026-10-01"));
    expect(query.sql).toMatch(/group by/i);
    expect(query.sql).toMatch(/count\(distinct/i);
    expect(query.sql).toMatch(/row_number\(\) over/i);
    expect(query.sql).toMatch(/generate_series/i);
    expect(query.sql).toMatch(/limit 1/i);
    expect(query.params).toContain("owner");
    expect(query.params).toContain("UTC");
    expect(query.params).toContain("2026-10-01");
    expect(query.sql).not.toMatch(/select \*/i);
  });
  it("maps the SQL summary without changing counts or weekly order", () => {
    expect(projectDashboardActivitySummary({ meaningfulThisWeek: 10, streak: 400, weeklyActivity: [0, 1, 2, 3, 0, 0, 4], completedLessons: 9 })).toEqual({
      meaningfulThisWeek: 10, streak: 400, weeklyActivity: [0, 1, 2, 3, 0, 0, 4], completedLessons: 9,
    });
    expect(projectDashboardActivitySummary(undefined)).toEqual({ meaningfulThisWeek: 0, streak: 0, weeklyActivity: [0, 0, 0, 0, 0, 0, 0], completedLessons: 0 });
  });
});
