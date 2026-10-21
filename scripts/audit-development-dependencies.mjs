import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Dev-only stack-exhaustion advisory, with no patched braces release.
// https://github.com/advisories/GHSA-vfj7-8cjw-p6xm
// Expires at 00:00 UTC on 2027-02-08; production findings are never exempt.
export const EXCEPTION = Object.freeze({
  advisory: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
  expiresAt: "2027-02-08T00:00:00.000Z",
});

const severities = ["info", "low", "moderate", "high", "critical"];
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = () => { throw new Error("Malformed npm audit report or dependency lock; refusing to waive findings."); };

export function checkDevelopmentAudit(report, lock, now = new Date()) {
  if (!record(report) || report.auditReportVersion !== 2 || "error" in report
    || !record(report.vulnerabilities) || !record(report.metadata?.vulnerabilities)
    || !record(lock) || lock.lockfileVersion !== 3 || !record(lock.packages)
    || !(now instanceof Date) || !Number.isFinite(now.getTime())) invalid();
  const vulnerabilities = report.vulnerabilities;
  const counts = Object.fromEntries(severities.map((severity) => [severity, 0]));
  for (const [name, finding] of Object.entries(vulnerabilities)) {
    if (!record(finding) || finding.name !== name || !severities.includes(finding.severity)
      || !Array.isArray(finding.via) || finding.via.length === 0
      || !Array.isArray(finding.nodes) || finding.nodes.length === 0
      || finding.nodes.some((node) => typeof node !== "string" || !Object.hasOwn(lock.packages, node))) invalid();
    counts[finding.severity]++;
    for (const cause of finding.via) {
      if (typeof cause === "string") {
        if (!Object.hasOwn(vulnerabilities, cause)) invalid();
      } else if (!record(cause) || typeof cause.url !== "string" || typeof cause.name !== "string"
        || typeof cause.dependency !== "string" || !severities.includes(cause.severity)
        || !Number.isSafeInteger(cause.source) || cause.source <= 0) invalid();
    }
  }
  const actualCounts = { ...counts, total: Object.keys(vulnerabilities).length };
  for (const [severity, count] of Object.entries(actualCounts)) {
    if (report.metadata.vulnerabilities[severity] !== count) invalid();
  }

  const active = now.getTime() < Date.parse(EXCEPTION.expiresAt);
  function solelyExempt(name, ancestors = new Set()) {
    // npm propagates the one advisory through micromatch/fast-glob/ESLint.
    // Resolve every branch to its advisory; never allowlist a package name.
    if (ancestors.has(name)) return false;
    const finding = vulnerabilities[name];
    if (finding.nodes.some((node) => lock.packages[node]?.dev !== true)) return false;
    const next = new Set([...ancestors, name]);
    return finding.via.every((cause) => typeof cause === "string"
      ? solelyExempt(cause, next)
      : active && name === "braces" && cause.name === "braces" && cause.dependency === "braces"
        && cause.url === EXCEPTION.advisory);
  }
  return Object.keys(vulnerabilities).filter((name) => !solelyExempt(name)).sort();
}

export function checkAuditProcess(result, lock, now = new Date()) {
  if (result.error || result.signal || ![0, 1].includes(result.status)
    || typeof result.stdout !== "string") throw new Error("npm audit failed to produce a usable report.");
  const report = JSON.parse(result.stdout);
  if (result.status === 0 && Object.keys(report.vulnerabilities ?? {}).length !== 0) invalid();
  if (result.status === 1 && Object.keys(report.vulnerabilities ?? {}).length === 0) invalid();
  return checkDevelopmentAudit(report, lock, now);
}

function main() {
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm",
    ["audit", "--include=dev", "--audit-level=low", "--json"], {
      encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
      // Windows .cmd requires a shell; command/arguments are fixed literals.
      shell: process.platform === "win32",
    });
  const failures = checkAuditProcess(result, JSON.parse(readFileSync("package-lock.json", "utf8")));
  if (failures.length) throw new Error(`Unexcepted/production/expired npm audit findings: ${failures.join(", ")}. Only ${EXCEPTION.advisory} is temporarily excepted for dev-only paths, until ${EXCEPTION.expiresAt}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
