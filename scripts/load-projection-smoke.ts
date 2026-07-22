import { performance } from "node:perf_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assertLoadTarget,
  resolveLoadReportPath,
  summarizeLoad,
  type RequestSample,
} from "../src/lib/performance/load-report";

const scenarios = [
  { name: "landing", path: "/" },
  { name: "catalog", path: "/courses" },
  { name: "learn", path: "/learn" },
  { name: "roadmap", path: "/roadmap" },
  { name: "review", path: "/review" },
] as const;

function integer(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function number(name: string, fallback: number, minimum: number): number {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`${name} must be a number at least ${minimum}.`);
  }
  return parsed;
}

function boundedError(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  if (error instanceof Error && error.name) return error.name.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 40);
  return "request_failed";
}

async function sample(url: URL, timeoutMs: number): Promise<RequestSample> {
  const started = performance.now();
  try {
    const response = await fetch(url, {
      cache: "no-store",
      redirect: "manual",
      headers: {
        accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return {
      durationMs: performance.now() - started,
      ok: response.status >= 200 && response.status < 400,
      status: response.status,
      ...(response.status >= 400 ? { errorCode: `http_${response.status}` } : {}),
    };
  } catch (error) {
    return { durationMs: performance.now() - started, ok: false, status: null, errorCode: boundedError(error) };
  }
}

async function runPool<T>(jobs: readonly (() => Promise<T>)[], concurrency: number): Promise<T[]> {
  const results = new Array<T>(jobs.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (cursor < jobs.length) {
      const index = cursor++;
      const job = jobs[index];
      if (job) results[index] = await job();
    }
  }));
  return results;
}

async function main() {
  const allowRemote = process.env.LOAD_ALLOW_REMOTE === "1";
  const base = assertLoadTarget(process.env.LOAD_BASE_URL ?? "http://127.0.0.1:3000", allowRemote);
  const concurrency = integer("LOAD_CONCURRENCY", 10, 1, 100);
  const requestsPerScenario = integer("LOAD_REQUESTS_PER_SCENARIO", 20, 1, 10_000);
  const timeoutMs = integer("LOAD_TIMEOUT_MS", 10_000, 100, 120_000);
  const warmupTimeoutMs = integer("LOAD_WARMUP_TIMEOUT_MS", 60_000, 100, 300_000);
  const p95LimitMs = number("LOAD_P95_LIMIT_MS", 1_500, 1);
  const allowedErrorRate = number("LOAD_ALLOWED_ERROR_RATE", 0, 0);
  if (allowedErrorRate > 1) throw new Error("LOAD_ALLOWED_ERROR_RATE cannot exceed one.");
  const scenarioReports = [];
  let failed = false;
  for (const scenario of scenarios) {
    const basePath = base.pathname === "/" ? "" : base.pathname.replace(/\/$/, "");
    const target = new URL(`${basePath}${scenario.path}`, base.origin);
    const warmup = await sample(target, warmupTimeoutMs); // Excluded from latency percentiles.
    if (!warmup.ok) {
      failed = true;
      scenarioReports.push({
        ...scenario,
        target: target.pathname,
        passed: false,
        warmupFailed: true,
        summary: summarizeLoad([warmup]),
      });
      continue;
    }
    const jobs = Array.from({ length: requestsPerScenario }, () => () => sample(target, timeoutMs));
    const summary = summarizeLoad(await runPool(jobs, concurrency));
    const passed = summary.errorRate <= allowedErrorRate && summary.p95Ms <= p95LimitMs;
    failed ||= !passed;
    scenarioReports.push({ ...scenario, target: target.pathname, passed, summary });
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    target: { origin: base.origin, remoteAuthorized: allowRemote },
    host: { platform: process.platform, arch: process.arch, node: process.version },
    config: { concurrency, requestsPerScenario, timeoutMs, warmupTimeoutMs, p95LimitMs, allowedErrorRate },
    scope: "Read-only application projection smoke; not NUC thermal, runner, tutor-first-token, or authenticated mutation evidence.",
    scenarios: scenarioReports,
    passed: !failed,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const reportPath = resolveLoadReportPath(process.cwd(), process.env.LOAD_REPORT_PATH);
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, serialized, { encoding: "utf8", flag: "wx" });
    process.stdout.write(`Load report written to ${path.relative(process.cwd(), reportPath)}.\n`);
  } else {
    process.stdout.write(serialized);
  }
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Load harness failed."}\n`);
  process.exitCode = 1;
});
