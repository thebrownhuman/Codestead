import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertLoadTarget,
  percentile,
  resolveLoadReportPath,
  summarizeLoad,
} from "../load-report";

describe("load evidence helpers", () => {
  it("uses nearest-rank percentiles without mutating samples", () => {
    const values = [100, 10, 50, 20];
    expect(percentile(values, 0.5)).toBe(20);
    expect(percentile(values, 0.95)).toBe(100);
    expect(values).toEqual([100, 10, 50, 20]);
    expect(() => percentile(values, 1.1)).toThrow(/between zero and one/i);
  });

  it("summarizes latency, failures, statuses, and bounded error codes", () => {
    expect(summarizeLoad([
      { durationMs: 10, ok: true, status: 200 },
      { durationMs: 20, ok: false, status: 503, errorCode: "http_503" },
      { durationMs: 30, ok: false, status: null, errorCode: "timeout" },
      { durationMs: 40, ok: true, status: 204 },
    ])).toEqual({
      requests: 4,
      succeeded: 2,
      failed: 2,
      errorRate: 0.5,
      p50Ms: 20,
      p95Ms: 40,
      p99Ms: 40,
      maxMs: 40,
      statuses: { "200": 1, "204": 1, "503": 1, none: 1 },
      errors: { http_503: 1, timeout: 1 },
    });
  });

  it("refuses accidental remote or credential-bearing targets", () => {
    expect(assertLoadTarget("http://127.0.0.1:3000/").href).toBe("http://127.0.0.1:3000/");
    expect(() => assertLoadTarget("https://learn.example.com")).toThrow(/explicit/i);
    expect(assertLoadTarget("https://learn.example.com", true).hostname).toBe("learn.example.com");
    expect(() => assertLoadTarget("http://user:secret@localhost:3000")).toThrow(/credentials/i);
    expect(() => assertLoadTarget("file:///tmp/app")).toThrow(/HTTP/i);
  });

  it("allows evidence/report output only under the two documented local roots", () => {
    const root = path.resolve("synthetic-workspace");
    expect(resolveLoadReportPath(root)).toBeNull();
    expect(resolveLoadReportPath(root, "docs/evidence/load.json")).toBe(path.join(root, "docs", "evidence", "load.json"));
    expect(resolveLoadReportPath(root, "test-results/load.json")).toBe(path.join(root, "test-results", "load.json"));
    expect(() => resolveLoadReportPath(root, "../outside.json")).toThrow(/must stay under/i);
    expect(() => resolveLoadReportPath(root, "docs/evidence/../../.env")).toThrow(/must stay under/i);
  });
});
