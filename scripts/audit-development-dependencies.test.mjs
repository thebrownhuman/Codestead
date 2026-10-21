import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { checkAuditProcess, checkDevelopmentAudit, EXCEPTION } from "./audit-development-dependencies.mjs";

const now = new Date("2026-10-03T00:00:00Z");
function fixture() {
  const names = ["braces", "micromatch", "fast-glob", "@next/eslint-plugin-next", "eslint-config-next"];
  const advisory = { source: 1240992, name: "braces", dependency: "braces", url: EXCEPTION.advisory, severity: "high" };
  const report = { auditReportVersion: 2, vulnerabilities: Object.fromEntries(names.map((name, index) =>
    [name, { name, severity: "high", nodes: [`node_modules/${name}`], via: index ? [names[index - 1]] : [advisory] }])),
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: names.length, critical: 0, total: names.length } } };
  const lock = { lockfileVersion: 3, packages: Object.fromEntries(names.map((name) => [`node_modules/${name}`, { dev: true }])) };
  return { report, lock };
}
function clean() {
  const { report, lock } = fixture();
  report.vulnerabilities = {};
  for (const severity of Object.keys(report.metadata.vulnerabilities)) report.metadata.vulnerabilities[severity] = 0;
  return { report, lock };
}

test("excepts only the dev-only GHSA and its complete propagated ESLint chain", () => {
  const { report, lock } = fixture();
  assert.deepEqual(checkDevelopmentAudit(report, lock, now), []);
  assert.deepEqual(checkAuditProcess({ status: 1, stdout: JSON.stringify(report) }, lock, now), []);
});

test("the exception fails at the exact expiry instant, but clean audits still pass", () => {
  const { report, lock } = fixture();
  const expiry = Date.parse(EXCEPTION.expiresAt);
  assert.deepEqual(checkDevelopmentAudit(report, lock, new Date(expiry - 1)), []);
  assert.equal(checkDevelopmentAudit(report, lock, new Date(EXCEPTION.expiresAt)).length, 5);
  assert.equal(checkDevelopmentAudit(report, lock, new Date(expiry + 24 * 60 * 60 * 1000)).length, 5);
  const empty = clean();
  assert.deepEqual(checkDevelopmentAudit(empty.report, empty.lock, new Date(EXCEPTION.expiresAt)), []);
});

for (const severity of ["info", "low", "moderate", "high", "critical"]) {
  test(`fails unrelated ${severity} advisories, even on an excepted package and propagated parents`, () => {
    const { report, lock } = fixture();
    report.vulnerabilities.braces.via.push({ source: 99, name: "braces", dependency: "braces",
      url: "https://github.com/advisories/GHSA-other", severity });
    assert.equal(checkDevelopmentAudit(report, lock, now).length, 5);
  });
}

test("fails an unrelated dev package", () => {
  const { report, lock } = fixture();
  report.vulnerabilities.other = { name: "other", severity: "low", nodes: ["node_modules/other"],
    via: [{ source: 100, name: "other", dependency: "other", severity: "low", url: "https://github.com/advisories/GHSA-other" }] };
  lock.packages["node_modules/other"] = { dev: true };
  report.metadata.vulnerabilities.low = 1;
  report.metadata.vulnerabilities.total++;
  assert.deepEqual(checkDevelopmentAudit(report, lock, now), ["other"]);
});

test("never excepts production or unclassified paths, including mixed nested installs", () => {
  for (const dev of [false, undefined]) {
    const { report, lock } = fixture();
    lock.packages["node_modules/braces"].dev = dev;
    assert.equal(checkDevelopmentAudit(report, lock, now).length, 5);
  }
  const { report, lock } = fixture();
  report.vulnerabilities.braces.nodes.push("node_modules/prod/node_modules/braces");
  lock.packages["node_modules/prod/node_modules/braces"] = { dev: false };
  assert.equal(checkDevelopmentAudit(report, lock, now).length, 5);
});

test("requires an exact advisory URL and braces identity", () => {
  for (const change of [{ url: `${EXCEPTION.advisory}?extra=1` }, { url: `${EXCEPTION.advisory}-suffix` },
    { name: "other" }, { dependency: "other" }]) {
    const { report, lock } = fixture();
    Object.assign(report.vulnerabilities.braces.via[0], change);
    assert.equal(checkDevelopmentAudit(report, lock, now).length, 5);
  }
});

test("cycles cannot hide an unknown cause", () => {
  const { report, lock } = fixture();
  report.vulnerabilities.braces.via.push("micromatch");
  assert.equal(checkDevelopmentAudit(report, lock, now).length, 5);
});

test("fails closed on registry errors, malformed/schema-incomplete reports and locks", () => {
  for (const mutate of [(r) => { r.error = { code: "E503" }; }, (r) => { delete r.auditReportVersion; },
    (r) => { r.vulnerabilities.braces.via = []; }, (r) => { r.vulnerabilities.braces.via = ["missing"]; },
    (r) => { r.vulnerabilities.braces.nodes = ["node_modules/missing"]; },
    (r) => { delete r.metadata.vulnerabilities.high; }, (r) => { r.vulnerabilities.braces.severity = "unknown"; }]) {
    const { report, lock } = fixture();
    mutate(report);
    assert.throws(() => checkDevelopmentAudit(report, lock, now));
  }
  assert.throws(() => checkDevelopmentAudit(fixture().report, {}, now));
  assert.throws(() => checkDevelopmentAudit(fixture().report, fixture().lock, new Date("invalid")));
});

test("network failures, truncated JSON, abnormal exits and contradictory statuses fail", () => {
  const { report, lock } = fixture();
  for (const result of [{ status: 2, stdout: JSON.stringify(report) }, { status: null, signal: "SIGTERM", stdout: "" },
    { status: 0, stdout: JSON.stringify(report) }, { status: 1, stdout: "{" },
    { status: 1, error: new Error("network"), stdout: JSON.stringify(report) },
    { status: 1, stdout: JSON.stringify(clean().report) }]) assert.throws(() => checkAuditProcess(result, lock, now));
  assert.deepEqual(checkAuditProcess({ status: 0, stdout: JSON.stringify(clean().report) }, lock, now), []);
});

test("CI retains strict production and dev gates", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /npm audit --omit=dev --audit-level=moderate/);
  assert.match(workflow, /node --test scripts\/audit-development-dependencies\.test\.mjs/);
  assert.match(workflow, /node scripts\/audit-development-dependencies\.mjs/);
  assert.doesNotMatch(workflow, /npm audit[^\n]*(?:\|\| true|continue-on-error)/);
});
