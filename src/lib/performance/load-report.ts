import path from "node:path";

export type RequestSample = {
  readonly durationMs: number;
  readonly ok: boolean;
  readonly status: number | null;
  readonly errorCode?: string;
};

export type LoadSummary = {
  readonly requests: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly errorRate: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly statuses: Readonly<Record<string, number>>;
  readonly errors: Readonly<Record<string, number>>;
};

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

export function percentile(values: readonly number[], fraction: number): number {
  if (!values.length) return 0;
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new RangeError("Percentile fraction must be between zero and one.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return rounded(sorted[index] ?? 0);
}

export function summarizeLoad(samples: readonly RequestSample[]): LoadSummary {
  const durations = samples.map((sample) => sample.durationMs);
  const statuses: Record<string, number> = {};
  const errors: Record<string, number> = {};
  let succeeded = 0;
  for (const sample of samples) {
    if (sample.ok) succeeded += 1;
    const status = sample.status === null ? "none" : String(sample.status);
    statuses[status] = (statuses[status] ?? 0) + 1;
    if (sample.errorCode) errors[sample.errorCode] = (errors[sample.errorCode] ?? 0) + 1;
  }
  const failed = samples.length - succeeded;
  return {
    requests: samples.length,
    succeeded,
    failed,
    errorRate: samples.length ? rounded(failed / samples.length) : 0,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    maxMs: rounded(Math.max(0, ...durations)),
    statuses,
    errors,
  };
}

export function assertLoadTarget(value: string, allowRemote = false): URL {
  const target = new URL(value);
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error("Load target must use HTTP or HTTPS.");
  }
  const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (!allowRemote && !loopback.has(target.hostname)) {
    throw new Error("Remote load targets require explicit LOAD_ALLOW_REMOTE=1 authorization.");
  }
  if (target.username || target.password) {
    throw new Error("Do not place credentials in the load-test URL.");
  }
  target.pathname = target.pathname.replace(/\/$/, "");
  target.search = "";
  target.hash = "";
  return target;
}

export function resolveLoadReportPath(root: string, configured?: string | null): string | null {
  const value = configured?.trim();
  if (!value) return null;
  const absolute = path.resolve(root, value);
  const allowedRoots = [path.resolve(root, "docs", "evidence"), path.resolve(root, "test-results")];
  if (!allowedRoots.some((allowed) => absolute === allowed || absolute.startsWith(`${allowed}${path.sep}`))) {
    throw new Error("LOAD_REPORT_PATH must stay under docs/evidence or test-results.");
  }
  return absolute;
}
